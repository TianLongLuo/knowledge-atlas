"""Canonical knowledge write-path service.

Single service layer for note mutations. PostgreSQL `Document` is the
canonical application record. Chroma contains only deterministic chunk IDs
linked by canonical `document_id` metadata.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, TypeVar

from sqlalchemy import delete as sa_delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import async_session_factory, get_chroma_collection
from models import Document, DocumentChunk, SyncState

logger = logging.getLogger(__name__)
T = TypeVar("T")


class NoteService:
    """Canonical CRUD for notes spanning PostgreSQL, ChromaDB, and optionally Notion."""

    def __init__(self, chunk_size: int = 500, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self._notion_schema_cache: dict[str, dict[str, str | None]] = {}
        self._writeback_tasks: dict[int, asyncio.Task] = {}
        self._writeback_versions: dict[int, int] = {}
        self._writeback_locks: dict[int, asyncio.Lock] = {}

    # ── Create ──────────────────────────────────────────────────────

    async def create(
        self,
        title: str,
        content: str,
        source: str = "manual",
        tags: str = "",
        category: str = "",
        db: AsyncSession | None = None,
    ) -> dict[str, Any]:
        """Create a canonical document with Chroma chunks and optional Notion write.

        Returns a dict with the canonical document info and sync state.
        """
        own_db = db is None
        if own_db:
            db_ctx = async_session_factory()
            session = await db_ctx.__aenter__()
        else:
            session = db

        try:
            # 1. Create PostgreSQL document
            now = datetime.now(timezone.utc)
            content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()[:32]
            doc = Document(
                source_type=source,
                source_id=None,  # manual notes have no external source_id initially
                title=title.strip(),
                raw_content=content,
                normalized_content=content,
                metadata_={"tags": tags, "category": category.strip(), "created_by": "manual"},
                content_hash=content_hash,
                created_at=now,
                updated_at=now,
            )
            session.add(doc)
            await session.flush()
            document_id = doc.id

            # 2. Chunk and embed
            from services.chunking import ChunkingService

            chunks = ChunkingService(
                chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap
            ).chunk_text(content)
            model = await asyncio.to_thread(self._get_embedding_model)
            vectors = await asyncio.to_thread(
                lambda: model.encode([chunk.text for chunk in chunks]).tolist()
            ) if chunks else []

            collection = get_chroma_collection()
            for chunk, vector in zip(chunks, vectors):
                chroma_id = f"document_{document_id}_chunk_{chunk.index}"
                collection.upsert(
                    ids=[chroma_id],
                    embeddings=[vector],
                    documents=[chunk.text],
                    metadatas=[{
                        "source": source,
                        "title": title.strip(),
                        "document_id": str(document_id),
                        "chunk_index": chunk.index,
                        "created_at": now.isoformat(),
                        "tags": tags,
                        "category": category.strip(),
                    }],
                )
                session.add(DocumentChunk(
                    document_id=document_id,
                    chunk_index=chunk.index,
                    chunk_text=chunk.text,
                    chunk_hash=chunk.hash,
                    chroma_id=chroma_id,
                    token_count=chunk.token_count,
                ))

            await session.flush()

            # 3. Optional Notion write (best-effort, track sync state)
            notion_sync_state = await self._enqueue_notion_write(session, doc)

            # 4. Invalidate caches
            from services.search_service import invalidate_search_cache
            from routers.graph import invalidate_graph_cache
            invalidate_search_cache()
            invalidate_graph_cache()

            if own_db:
                await session.commit()

            return {
                "id": document_id,
                "title": title.strip(),
                "source": doc.source_type,
                "created_at": now.isoformat(),
                "chunk_count": len(chunks),
                "notion_sync": notion_sync_state,
            }
        except Exception:
            if own_db:
                await session.rollback()
            raise
        finally:
            if own_db:
                await db_ctx.__aexit__(None, None, None)

    # ── Read ────────────────────────────────────────────────────────

    async def read(
        self, document_id: int, db: AsyncSession
    ) -> Document | None:
        """Resolve one canonical document, with legacy-Chroma fallback for negative IDs."""
        if document_id < 0:
            return None  # Legacy Chroma — handled by documents router
        return await db.get(Document, document_id)

    # ── Update ─────────────────────────────────────────────────────

    async def update(
        self,
        document_id: int,
        title: str | None = None,
        content: str | None = None,
        tags: str | None = None,
        category: str | None = None,
        db: AsyncSession | None = None,
    ) -> dict[str, Any]:
        """Update PostgreSQL document, replace chunks, enqueue Notion write-back."""
        own_db = db is None
        if own_db:
            db_ctx = async_session_factory()
            session = await db_ctx.__aenter__()
        else:
            session = db

        try:
            doc = await session.get(Document, document_id)
            if doc is None:
                raise ValueError(f"Document {document_id} not found")

            changed = False
            if title is not None and title.strip():
                doc.title = title.strip()
                changed = True
            new_content = None
            if content is not None:
                new_content = content
                doc.raw_content = content
                doc.normalized_content = content
                changed = True
            if tags is not None or category is not None:
                metadata = dict(doc.metadata_ or {})
                if tags is not None:
                    metadata["tags"] = tags.strip()
                if category is not None:
                    metadata["category"] = category.strip()
                doc.metadata_ = metadata
                changed = True

            if not changed:
                if own_db:
                    await session.commit()
                return {"id": doc.id, "updated": False}

            # Re-chunk if content changed
            if new_content is not None:
                content_hash = hashlib.sha256(
                    new_content.encode("utf-8")
                ).hexdigest()[:32]
                doc.content_hash = content_hash
                try:
                    async with session.begin_nested():
                        await self._reindex_chunks(session, doc, new_content)
                    metadata = dict(doc.metadata_ or {})
                    metadata["vector_sync_status"] = "completed"
                    metadata.pop("vector_sync_error", None)
                    doc.metadata_ = metadata
                except Exception as exc:
                    # PostgreSQL is canonical. A vector-store outage must never
                    # make the writing surface lose a local draft.
                    logger.exception("Vector reindex failed for document %s", doc.id)
                    metadata = dict(doc.metadata_ or {})
                    metadata["vector_sync_status"] = "failed"
                    metadata["vector_sync_error"] = str(exc)[:1000]
                    doc.metadata_ = metadata
            elif tags is not None or category is not None or title is not None:
                try:
                    await self._refresh_chroma_metadata(doc)
                except Exception as exc:
                    logger.exception("Vector metadata refresh failed for document %s", doc.id)
                    metadata = dict(doc.metadata_ or {})
                    metadata["vector_sync_status"] = "failed"
                    metadata["vector_sync_error"] = str(exc)[:1000]
                    doc.metadata_ = metadata

            doc.updated_at = datetime.now(timezone.utc)
            await session.flush()

            # Notion write-back for all documents
            notion_sync_state = await self._enqueue_notion_write(session, doc)

            # Invalidate caches
            from services.search_service import invalidate_search_cache
            from routers.graph import invalidate_graph_cache
            invalidate_search_cache()
            invalidate_graph_cache()

            if own_db:
                await session.commit()

            return {
                "id": doc.id,
                "updated": True,
                "notion_sync": notion_sync_state,
            }
        except Exception:
            if own_db:
                await session.rollback()
            raise
        finally:
            if own_db:
                await db_ctx.__aexit__(None, None, None)

    # ── Delete ─────────────────────────────────────────────────────

    async def delete(
        self, document_id: int, db: AsyncSession
    ) -> dict[str, Any]:
        """Delete canonical document, Chroma chunks, and optionally archive Notion page."""
        doc = await db.get(Document, document_id)
        if doc is None:
            raise ValueError(f"Document {document_id} not found")

        # Delete Chroma chunks
        chunks_result = await db.execute(
            select(DocumentChunk).where(DocumentChunk.document_id == document_id)
        )
        chunks = chunks_result.scalars().all()
        chroma_ids = [c.chroma_id for c in chunks if c.chroma_id]
        if chroma_ids:
            try:
                collection = get_chroma_collection()
                collection.delete(ids=chroma_ids)
            except Exception:
                logger.exception("Failed to delete Chroma chunks for doc %s", document_id)

        # Archive Notion page if linked
        notion_action = None
        if self._linked_notion_page_id(doc):
            notion_action = await self._archive_notion_page(doc)

        await db.delete(doc)
        await db.flush()

        from services.search_service import invalidate_search_cache
        from routers.graph import invalidate_graph_cache
        invalidate_search_cache()
        invalidate_graph_cache()

        return {
            "id": document_id,
            "deleted": True,
            "notion_action": notion_action,
        }

    # ── Internal helpers ────────────────────────────────────────────

    async def _reindex_chunks(self, db: AsyncSession, doc: Document, content: str) -> None:
        """Atomically rebuild SQL chunk rows and idempotently upsert Chroma chunks."""
        from services.chunking import ChunkingService

        chunks = ChunkingService(
            chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap
        ).chunk_text(content)
        model = await asyncio.to_thread(self._get_embedding_model)
        vectors = await asyncio.to_thread(
            lambda: model.encode([chunk.text for chunk in chunks]).tolist()
        ) if chunks else []

        collection = get_chroma_collection()
        # Delete old Chroma chunks for this document
        collection.delete(where={"document_id": str(doc.id)})

        # Delete old SQL chunks
        await db.execute(sa_delete(DocumentChunk).where(DocumentChunk.document_id == doc.id))

        metadata = doc.metadata_ or {}
        for chunk, vector in zip(chunks, vectors):
            chroma_id = f"document_{doc.id}_chunk_{chunk.index}"
            collection.upsert(
                ids=[chroma_id],
                embeddings=[vector],
                documents=[chunk.text],
                metadatas=[{
                    "source": doc.source_type,
                    "title": doc.title,
                    "document_id": str(doc.id),
                    "chunk_index": chunk.index,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "url": str(metadata.get("url") or ""),
                    "tags": str(metadata.get("tags") or ""),
                    "category": str(metadata.get("category") or ""),
                }],
            )
            db.add(DocumentChunk(
                document_id=doc.id,
                chunk_index=chunk.index,
                chunk_text=chunk.text,
                chunk_hash=chunk.hash,
                chroma_id=chroma_id,
                token_count=chunk.token_count,
            ))

    async def _refresh_chroma_metadata(self, doc: Document) -> None:
        """Keep vector metadata aligned when title, category, or tags change."""
        collection = get_chroma_collection()
        result = collection.get(
            where={"document_id": str(doc.id)},
            include=["metadatas"],
        )
        ids = list(result.get("ids") or [])
        if not ids:
            return
        metadata = doc.metadata_ or {}
        existing = list(result.get("metadatas") or [{}] * len(ids))
        collection.update(
            ids=ids,
            metadatas=[{
                **(item or {}),
                "source": doc.source_type,
                "title": doc.title,
                "tags": str(metadata.get("tags") or ""),
                "category": str(metadata.get("category") or ""),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            } for item in existing],
        )

    async def _push_to_notion(
        self, db: AsyncSession, doc: Document
    ) -> dict[str, Any] | None:
        """Serialize writes for one note so autosave cannot duplicate Notion work."""
        lock = self._writeback_locks.setdefault(doc.id, asyncio.Lock())
        async with lock:
            return await self._push_to_notion_unlocked(db, doc)

    async def _push_to_notion_unlocked(
        self, db: AsyncSession, doc: Document
    ) -> dict[str, Any] | None:
        """Create or replace the linked Notion page without silent truncation.

        PostgreSQL remains canonical. A Notion failure never rolls back the local
        note, but it is persisted in ``SyncState`` and document metadata so the UI
        and operators can see that write-back needs attention.
        """
        if not settings.notion_api_key or not settings.notion_database_id:
            return {"status": "not_configured"}

        state: SyncState | None = None
        notion_page_id: str | None = self._linked_notion_page_id(doc)
        created_new_page = False
        try:
            state = await self._set_notion_sync_state(db, doc, "running")
            # Release the advisory/sync-state row locks before remote network
            # calls so another web worker can continue saving the note.
            await db.commit()
            from notion_client import AsyncClient

            notion = AsyncClient(auth=settings.notion_api_key)
            content = doc.normalized_content or doc.raw_content or ""
            text_blocks = self._content_to_notion_blocks(content)
            schema = await self._get_notion_database_schema(notion)
            properties = self._notion_page_properties(doc, schema)
            if notion_page_id:
                page = await self._notion_call(
                    "update page properties",
                    lambda: notion.pages.update(
                        page_id=notion_page_id,
                        properties=properties,
                    ),
                )
                metadata = dict(doc.metadata_ or {})
                current_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                if metadata.get("notion_content_hash") != current_hash:
                    await self._replace_notion_page_content(
                        notion, notion_page_id, text_blocks
                    )
            else:
                first_batch, remaining = text_blocks[:100], text_blocks[100:]
                page = await self._notion_call(
                    "create page",
                    lambda: notion.pages.create(
                        parent={"database_id": settings.notion_database_id},
                        properties=properties,
                        children=first_batch,
                    ),
                )
                notion_page_id = str(page["id"])
                created_new_page = True
                await self._append_notion_blocks(notion, notion_page_id, remaining)
                logger.info(
                    "Created Notion page %s for document %s", notion_page_id, doc.id
                )

            # Reload after network I/O so status fields never overwrite title,
            # body, or tags saved by a newer autosave transaction.
            await db.refresh(doc)
            if created_new_page:
                doc.source_type = "notion"
                doc.source_id = notion_page_id
            metadata = dict(doc.metadata_ or {})
            metadata.update({
                "notion_page_id": notion_page_id,
                "notion_url": page.get("url") or metadata.get("notion_url", ""),
                "notion_content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "notion_sync_status": "completed",
            })
            metadata.pop("notion_sync_error", None)
            doc.metadata_ = metadata
            if state is not None:
                state.status = "completed"
                state.error_message = None
                state.last_synced_at = datetime.now(timezone.utc)
            await db.flush()
            return {"status": "completed", "notion_page_id": notion_page_id}
        except Exception as exc:
            message = self._safe_notion_error(exc)
            logger.exception("Failed to push doc %s to Notion", doc.id)
            # If page creation succeeded before a later block upload failed,
            # retain the page link so the retry updates instead of duplicating it.
            if notion_page_id and created_new_page:
                try:
                    await db.refresh(doc)
                    doc.source_type = "notion"
                    doc.source_id = notion_page_id
                except Exception:
                    logger.exception("Unable to retain partial Notion page link for doc %s", doc.id)
            metadata = dict(doc.metadata_ or {})
            if notion_page_id:
                metadata["notion_page_id"] = notion_page_id
            metadata["notion_sync_status"] = "failed"
            metadata["notion_sync_error"] = message
            doc.metadata_ = metadata
            if state is not None:
                state.status = "failed"
                state.error_message = message
            await db.flush()
            return {"status": "failed", "error": message}

    async def _set_notion_sync_state(
        self, db: AsyncSession, doc: Document, status: str
    ) -> SyncState:
        # One transaction-level lock prevents concurrent autosaves from both
        # creating the same sync-state row. It also lets us repair historical
        # duplicate rows left by deployments that predated the unique index.
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
            {"lock_key": f"notion-writeback:{doc.id}"},
        )
        result = await db.execute(
            select(SyncState)
            .where(
                SyncState.source_type == "notion_writeback",
                SyncState.source_id == str(doc.id),
            )
            .order_by(SyncState.id.desc())
        )
        states = result.scalars().all()
        state = states[0] if states else None
        for duplicate in states[1:]:
            await db.delete(duplicate)
        if state is None:
            state = SyncState(
                source_type="notion_writeback",
                source_id=str(doc.id),
            )
            db.add(state)
        state.status = status
        state.error_message = None
        if status == "pending":
            metadata = dict(doc.metadata_ or {})
            metadata["notion_sync_status"] = status
            metadata.pop("notion_sync_error", None)
            doc.metadata_ = metadata
        await db.flush()
        return state

    async def _get_notion_database_schema(self, notion: Any) -> dict[str, str | None]:
        database_id = settings.notion_database_id
        cached = self._notion_schema_cache.get(database_id)
        if cached and cached.get("tags"):
            return cached

        database = await self._notion_call(
            "read database schema",
            lambda: notion.databases.retrieve(database_id=database_id),
        )
        properties = database.get("properties") or {}
        title_name = next(
            (name for name, value in properties.items() if value.get("type") == "title"),
            None,
        )
        if not title_name:
            raise RuntimeError("The configured Notion database has no title property")

        def known_property(names: set[str], property_type: str) -> str | None:
            for name, value in properties.items():
                if name.strip().casefold() in names and value.get("type") == property_type:
                    return name
            return None

        schema = {
            "title": title_name,
            "tags": known_property({"tags", "tag", "标签", "標籤"}, "multi_select"),
            "category": known_property({"category", "type", "分类", "分類", "类别", "類別"}, "select"),
        }
        if not schema["tags"]:
            await self._notion_call(
                "create Tags property",
                lambda: notion.databases.update(
                    database_id=database_id,
                    properties={"Tags": {"multi_select": {}}},
                ),
            )
            schema["tags"] = "Tags"
        self._notion_schema_cache[database_id] = schema
        return schema

    @staticmethod
    def _notion_page_properties(
        doc: Document, schema: dict[str, str | None]
    ) -> dict[str, Any]:
        properties: dict[str, Any] = {
            str(schema["title"]): {
                "title": [{"type": "text", "text": {"content": doc.title[:2000]}}]
            }
        }
        metadata = doc.metadata_ or {}
        tags_name = schema.get("tags")
        if tags_name:
            raw_tags = metadata.get("tags") or []
            tags = raw_tags if isinstance(raw_tags, list) else str(raw_tags).replace("，", ",").split(",")
            clean_tags = [str(tag).strip()[:100] for tag in tags if str(tag).strip()]
            properties[tags_name] = {"multi_select": [{"name": tag} for tag in clean_tags[:100]]}
        category_name = schema.get("category")
        category = str(metadata.get("category") or "").strip()
        if category_name and category:
            properties[category_name] = {"select": {"name": category[:100]}}
        return properties

    async def _replace_notion_page_content(
        self, notion: Any, page_id: str, blocks: list[dict]
    ) -> None:
        cursor = None
        existing_ids: list[str] = []
        while True:
            response = await self._notion_call(
                "list existing page blocks",
                lambda cursor=cursor: notion.blocks.children.list(
                    block_id=page_id,
                    start_cursor=cursor,
                    page_size=100,
                ),
            )
            existing_ids.extend(str(block["id"]) for block in response.get("results", []))
            if not response.get("has_more"):
                break
            cursor = response.get("next_cursor")

        for block_id in existing_ids:
            await self._notion_call(
                "remove old page block",
                lambda block_id=block_id: notion.blocks.delete(block_id=block_id),
            )
        await self._append_notion_blocks(notion, page_id, blocks)

    async def _append_notion_blocks(
        self, notion: Any, page_id: str, blocks: list[dict]
    ) -> None:
        for start in range(0, len(blocks), 100):
            batch = blocks[start:start + 100]
            await self._notion_call(
                "append page blocks",
                lambda batch=batch: notion.blocks.children.append(
                    block_id=page_id,
                    children=batch,
                ),
            )

    @staticmethod
    async def _notion_call(
        operation_name: str,
        operation: Callable[[], Awaitable[T]],
        attempts: int = 3,
    ) -> T:
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                return await operation()
            except Exception as exc:
                last_error = exc
                if attempt + 1 >= attempts:
                    break
                response = getattr(exc, "response", None)
                headers = getattr(response, "headers", {}) or {}
                retry_after = headers.get("retry-after") if hasattr(headers, "get") else None
                try:
                    delay = max(float(retry_after), 0.1) if retry_after else 0.5 * (2 ** attempt)
                except (TypeError, ValueError):
                    delay = 0.5 * (2 ** attempt)
                logger.warning(
                    "Notion operation '%s' failed (attempt %s/%s): %s",
                    operation_name, attempt + 1, attempts, exc,
                )
                await asyncio.sleep(min(delay, 5.0))
        raise RuntimeError(f"Notion {operation_name} failed: {last_error}") from last_error

    @staticmethod
    def _linked_notion_page_id(doc: Document) -> str | None:
        metadata = doc.metadata_ or {}
        linked = metadata.get("notion_page_id")
        if linked:
            return str(linked)
        if doc.source_type == "notion" and doc.source_id:
            return str(doc.source_id)
        return None

    @staticmethod
    def _safe_notion_error(exc: Exception) -> str:
        message = str(exc).strip() or exc.__class__.__name__
        return message[:2000]

    @staticmethod
    def _content_to_notion_blocks(content: str) -> list[dict]:
        """Convert the complete note to Notion blocks without a 100-block cap."""
        if not content.strip():
            return [{
                "object": "block",
                "type": "paragraph",
                "paragraph": {"rich_text": [{"type": "text", "text": {"content": ""}}]},
            }]
        blocks: list[dict] = []
        # Keep original line breaks while staying below Notion's 2,000-char
        # rich-text limit. Empty lines remain visible as empty paragraphs.
        for i in range(0, len(content), 1900):
            chunk = content[i:i + 1900]
            blocks.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": chunk}}],
                },
            })
        return blocks

    async def _enqueue_notion_write(
        self, db: AsyncSession, doc: Document
    ) -> dict[str, Any] | None:
        """Durably queue one debounced Notion write without blocking autosave."""
        if not settings.notion_api_key or not settings.notion_database_id:
            return {"status": "not_configured"}
        active_task = self._writeback_tasks.get(doc.id)
        active_lock = self._writeback_locks.get(doc.id)
        write_in_progress = bool(
            (active_task and not active_task.done())
            or (active_lock and active_lock.locked())
        )
        if not write_in_progress:
            try:
                await self._set_notion_sync_state(db, doc, "pending")
            except Exception:
                # The Atlas save remains authoritative even if sync bookkeeping
                # is temporarily unhealthy. The worker can recover later.
                logger.exception("Unable to mark Notion write pending for document %s", doc.id)
        else:
            metadata = dict(doc.metadata_ or {})
            metadata["notion_sync_status"] = "pending"
            doc.metadata_ = metadata
        self._schedule_notion_write(doc.id)
        return {"status": "pending"}

    def _schedule_notion_write(self, document_id: int) -> None:
        self._writeback_versions[document_id] = self._writeback_versions.get(document_id, 0) + 1
        existing = self._writeback_tasks.get(document_id)
        if existing and not existing.done():
            return
        task = asyncio.create_task(self._run_debounced_notion_write(document_id))
        self._writeback_tasks[document_id] = task

        def finish(completed: asyncio.Task) -> None:
            if self._writeback_tasks.get(document_id) is completed:
                self._writeback_tasks.pop(document_id, None)
                self._writeback_versions.pop(document_id, None)
            try:
                completed.result()
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("Debounced Notion write failed for document %s", document_id)

        task.add_done_callback(finish)

    async def _run_debounced_notion_write(self, document_id: int) -> None:
        while True:
            version = self._writeback_versions.get(document_id, 0)
            await asyncio.sleep(settings.notion_writeback_debounce_seconds)
            if version != self._writeback_versions.get(document_id, 0):
                continue
            async with async_session_factory() as db:
                doc = await db.get(Document, document_id)
                if doc is None:
                    return
                await self._push_to_notion(db, doc)
                await db.commit()
            if version == self._writeback_versions.get(document_id, 0):
                return

    async def cancel_pending_writebacks(self) -> None:
        tasks = [task for task in self._writeback_tasks.values() if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._writeback_tasks.clear()
        self._writeback_versions.clear()

    async def retry_failed_notion_writebacks(
        self, db: AsyncSession, limit: int = 20
    ) -> dict[str, int]:
        """Retry durable failed write-backs during the automatic sync cycle."""
        result = await db.execute(
            select(SyncState)
            .where(
                SyncState.source_type == "notion_writeback",
                SyncState.status.in_(("pending", "failed")),
            )
            .order_by(SyncState.updated_at.asc())
            .limit(limit)
        )
        states = result.scalars().all()
        completed = 0
        failed = 0
        for state in states:
            try:
                document_id = int(state.source_id)
            except (TypeError, ValueError):
                failed += 1
                continue
            doc = await db.get(Document, document_id)
            if doc is None:
                await db.delete(state)
                continue
            outcome = await self._push_to_notion(db, doc)
            if outcome and outcome.get("status") == "completed":
                completed += 1
            else:
                failed += 1
            await db.commit()
        return {"attempted": len(states), "completed": completed, "failed": failed}

    async def sync_document_to_notion(
        self, db: AsyncSession, document_id: int
    ) -> dict[str, Any]:
        """Explicitly retry one document's Notion write-back."""
        doc = await db.get(Document, document_id)
        if doc is None:
            raise ValueError(f"Document {document_id} not found")
        result = await self._push_to_notion(db, doc)
        return result or {"status": "not_configured"}

    async def _archive_notion_page(self, doc: Document) -> str | None:
        """Best-effort Notion page archival. Returns 'archived', 'error', or None."""
        if not settings.notion_api_key:
            return None
        try:
            from notion_client import AsyncClient
            notion = AsyncClient(auth=settings.notion_api_key)
            page_id = self._linked_notion_page_id(doc)
            if not page_id:
                return None
            await self._notion_call(
                "archive page",
                lambda: notion.pages.update(
                    page_id=page_id,
                    archived=True,
                ),
            )
            return "archived"
        except Exception:
            logger.exception("Failed to archive Notion page %s", doc.source_id)
            return "error"

    @staticmethod
    def _get_embedding_model():
        from services.search_service import _get_embedding_model as _gem
        return _gem()


# Singleton instance
note_service = NoteService()
