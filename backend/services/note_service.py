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
from typing import Any

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import async_session_factory, get_chroma_collection
from models import Document, DocumentChunk, SyncState

logger = logging.getLogger(__name__)


class NoteService:
    """Canonical CRUD for notes spanning PostgreSQL, ChromaDB, and optionally Notion."""

    def __init__(self, chunk_size: int = 500, chunk_overlap: int = 50):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

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
            notion_sync_state = None
            if settings.notion_api_key and settings.notion_database_id:
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
                "source": source,
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
                await self._reindex_chunks(session, doc, new_content)

            doc.updated_at = datetime.now(timezone.utc)
            await session.flush()

            # Notion write-back for all documents
            notion_sync_state = None
            if doc.source_id:
                # Already linked to Notion — update the existing page
                notion_sync_state = await self._enqueue_notion_write(session, doc)
            else:
                # New to Notion — create a page and link it
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
        if doc.source_type == "notion" and doc.source_id:
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

    async def _push_to_notion(
        self, db: AsyncSession, doc: Document
    ) -> dict[str, Any] | None:
        """Push document to Notion: create or update a page in the configured database.

        After first successful push, the document's source_type becomes 'notion'
        and source_id is set, so future edits update the same Notion page.
        """
        if not settings.notion_api_key or not settings.notion_database_id:
            return None

        try:
            from notion_client import AsyncClient

            notion = AsyncClient(auth=settings.notion_api_key)
            content = doc.normalized_content or doc.raw_content or ""
            # Truncate for Notion's 2000-char text block limit; split into chunks
            text_blocks = self._content_to_notion_blocks(content)

            if doc.source_type == "notion" and doc.source_id:
                # Update existing Notion page
                try:
                    await notion.blocks.children.append(
                        block_id=doc.source_id,
                        children=text_blocks[:100],
                    )
                    # Also update the page title
                    await notion.pages.update(
                        page_id=doc.source_id,
                        properties={
                            "Name": {"title": [{"text": {"content": doc.title[:2000]}}]},
                        },
                    )
                except Exception as update_err:
                    logger.warning(
                        "Notion page update failed for %s, attempting recreate: %s",
                        doc.source_id, update_err,
                    )
                    # Fall through to create new page
                    doc.source_id = None

            if not doc.source_id:
                # Create new Notion page
                new_page = await notion.pages.create(
                    parent={"database_id": settings.notion_database_id},
                    properties={
                        "Name": {"title": [{"text": {"content": doc.title[:2000]}}]},
                    },
                    children=text_blocks[:100],
                )
                doc.source_type = "notion"
                doc.source_id = new_page["id"]
                if doc.metadata_ is None:
                    doc.metadata_ = {}
                doc.metadata_["notion_url"] = new_page.get("url", "")
                logger.info(
                    "Created Notion page %s for document %s", new_page["id"], doc.id
                )

            # Record sync state
            result = await db.execute(
                select(SyncState).where(
                    SyncState.source_type == "notion_writeback",
                    SyncState.source_id == str(doc.id),
                )
            )
            state = result.scalar_one_or_none()
            if state is None:
                state = SyncState(
                    source_type="notion_writeback",
                    source_id=str(doc.id),
                )
                db.add(state)
            state.status = "completed"
            state.last_synced_at = datetime.now(timezone.utc)
            await db.flush()
            return {"status": "completed", "notion_page_id": doc.source_id}
        except Exception:
            logger.exception("Failed to push doc %s to Notion", doc.id)
            return {"status": "error"}

    @staticmethod
    def _content_to_notion_blocks(content: str) -> list[dict]:
        """Convert plain text to Notion paragraph blocks, splitting long text."""
        if not content.strip():
            return [{
                "object": "block",
                "type": "paragraph",
                "paragraph": {"rich_text": [{"type": "text", "text": {"content": ""}}]},
            }]
        blocks = []
        # Split content into ~2000 char chunks (Notion text limit)
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
        """Push document to Notion and record sync state.

        Returns sync state dict or None if Notion is not configured.
        """
        return await self._push_to_notion(db, doc)

    async def _archive_notion_page(self, doc: Document) -> str | None:
        """Best-effort Notion page archival. Returns 'archived', 'error', or None."""
        if not settings.notion_api_key:
            return None
        try:
            from notion_client import AsyncClient
            notion = AsyncClient(auth=settings.notion_api_key)
            await notion.pages.update(
                page_id=doc.source_id,
                archived=True,
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
