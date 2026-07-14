"""Notion sync service.

Fetches pages from a Notion database, normalizes them into Document
format, chunks them, generates embeddings, and stores everything in
PostgreSQL + ChromaDB.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import async_session_factory, get_chroma_collection
from models import Document, DocumentChunk, SyncState
from services.chunking import ChunkingService

logger = logging.getLogger(__name__)


class NotionSyncService:
    """Handles full synchronization between Notion and the knowledge atlas."""

    def __init__(self):
        self.chunking = ChunkingService(chunk_size=500, chunk_overlap=50)

    def _get_notion_client(self):
        """Lazy init the Notion client."""
        from notion_client import AsyncClient

        return AsyncClient(auth=settings.notion_api_key)

    async def sync_all(self, sync_state_id: int) -> None:
        """Fetch all pages from the configured Notion database and sync."""
        notion = self._get_notion_client()
        db_id = settings.notion_database_id

        if not db_id:
            await self._fail_sync(sync_state_id, "NOTION_DATABASE_ID not configured")
            return

        async with async_session_factory() as db:
            try:
                # Update sync state to running
                sync_state = await db.get(SyncState, sync_state_id)
                if sync_state:
                    sync_state.status = "running"
                    await db.commit()

                # Query all pages from the Notion database
                pages = await self._fetch_all_pages(notion, db_id)
                logger.info(f"Fetched {len(pages)} pages from Notion database {db_id}")

                if not pages:
                    await self._complete_sync(sync_state_id, db, 0)
                    return

                processed = 0
                page_errors: list[str] = []
                for page in pages:
                    try:
                        await self._process_page(page, notion, db)
                        processed += 1
                    except Exception as e:
                        logger.error(f"Error processing Notion page {page.get('id')}: {e}")
                        page_errors.append(f"{page.get('id')}: {e}")

                if page_errors:
                    raise RuntimeError(
                        f"{len(page_errors)} Notion page(s) were not fully synchronized; "
                        "their existing content was retained. " + "; ".join(page_errors[:3])
                    )

                await self._complete_sync(sync_state_id, db, processed)

            except Exception as e:
                logger.error(f"Notion sync failed: {e}")
                await self._fail_sync(sync_state_id, str(e))
                raise

    async def _fetch_all_pages(self, notion, database_id: str) -> list[dict]:
        """Fetch all pages from a Notion database with pagination."""
        all_pages = []
        start_cursor = None

        while True:
            params = {
                "database_id": database_id,
                "page_size": 100,
            }
            if start_cursor:
                params["start_cursor"] = start_cursor

            response = await notion.databases.query(**params)
            pages = response.get("results", [])
            all_pages.extend(pages)

            if not response.get("has_more"):
                break
            start_cursor = response.get("next_cursor")

        return all_pages

    async def _process_page(self, page: dict, notion, db: AsyncSession) -> None:
        """Process a single Notion page into a Document with chunks."""
        page_id = page["id"]

        # Extract page properties
        properties = page.get("properties", {})

        # Get title
        title = self._extract_title(properties)

        # Get the full page content (blocks)
        raw_content = await self._fetch_page_content(notion, page_id)
        normalized = self._normalize_content(raw_content)

        # Compute content hash for dedup
        content_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]

        # Get Notion URL
        url = page.get("url", "")

        # Extract metadata from page properties
        metadata = {
            "url": url,
            "notion_page_id": page_id,
            "notion_last_edited": page.get("last_edited_time", ""),
            "created_time": page.get("created_time", ""),
            "tags": self._extract_tags(properties),
        }

        # Check for existing document
        result = await db.execute(
            select(Document).where(
                Document.source_type == "notion",
                Document.source_id == page_id,
            )
        )
        existing = result.scalar_one_or_none()

        if existing and existing.content_hash == content_hash:
            logger.debug(f"Notion page {page_id} unchanged, skipping")
            return

        if existing:
            # Update existing
            existing.title = title
            existing.raw_content = raw_content
            existing.normalized_content = normalized
            existing.content_hash = content_hash
            existing.metadata_ = metadata
            existing.updated_at = datetime.now(timezone.utc)

            # Delete old chunks
            from sqlalchemy import delete as sa_delete

            await db.execute(
                sa_delete(DocumentChunk).where(DocumentChunk.document_id == existing.id)
            )
            await db.flush()
            document_id = existing.id
        else:
            # Create new document
            doc = Document(
                source_type="notion",
                source_id=page_id,
                title=title,
                raw_content=raw_content,
                normalized_content=normalized,
                metadata_=metadata,
                content_hash=content_hash,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
            db.add(doc)
            await db.flush()
            document_id = doc.id

        # Chunk the content
        chunks = self.chunking.chunk_text(normalized)

        # Generate embeddings and store in ChromaDB
        collection = get_chroma_collection()
        embedding_model = await asyncio.to_thread(self._get_embedding_model)
        vectors = await asyncio.to_thread(
            lambda: embedding_model.encode([chunk.text for chunk in chunks]).tolist()
        ) if chunks else []

        # Remove stale chunks first. Upsert then makes interrupted retries idempotent.
        collection.delete(where={"document_id": str(document_id)})

        for chunk, vector in zip(chunks, vectors):

            # Store in ChromaDB
            chroma_id = f"notion_{page_id}_chunk_{chunk.index}"
            try:
                collection.upsert(
                    ids=[chroma_id],
                    embeddings=[vector],
                    documents=[chunk.text],
                    metadatas=[{
                        "source": "notion",
                        "title": title,
                        "url": url,
                        "document_id": str(document_id),
                        "chunk_index": chunk.index,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "tags": ",".join(metadata.get("tags", [])),
                    }],
                )
            except Exception as e:
                logger.warning(f"ChromaDB add error for {chroma_id}: {e}")

            # Store in PostgreSQL
            db_chunk = DocumentChunk(
                document_id=document_id,
                chunk_index=chunk.index,
                chunk_text=chunk.text,
                chunk_hash=chunk.hash,
                chroma_id=chroma_id,
                token_count=chunk.token_count,
            )
            db.add(db_chunk)

        await db.commit()
        from services.search_service import invalidate_search_cache
        from routers.graph import invalidate_graph_cache

        invalidate_search_cache()
        invalidate_graph_cache()
        logger.info(f"Synced Notion page: {title} ({len(chunks)} chunks)")

    async def _fetch_page_content(self, notion, page_id: str) -> str:
        """Fetch all block content for a Notion page, recursively including child blocks."""
        blocks = await self._fetch_blocks_recursive(notion, page_id, depth=0)
        return self._blocks_to_text(blocks)

    async def _fetch_blocks_recursive(
        self,
        notion,
        block_id: str,
        depth: int = 0,
        max_depth: int = 32,
        _seen_ids: set[str] | None = None,
    ) -> list[dict]:
        """Fetch every block page strictly; never return a silently partial document."""
        all_blocks: list[dict] = []
        if depth >= max_depth:
            raise RuntimeError(f"Notion block nesting exceeded {max_depth} levels at {block_id}")

        seen_ids = _seen_ids if _seen_ids is not None else set()
        start_cursor = None

        while True:
            params: dict = {"block_id": block_id, "page_size": 100}
            if start_cursor:
                params["start_cursor"] = start_cursor

            response = await notion.blocks.children.list(**params)
            batch = response.get("results", [])
            if not isinstance(batch, list):
                raise RuntimeError(f"Invalid Notion block response for {block_id}")
            for block in batch:
                child_id = str(block.get("id", ""))
                if child_id and child_id in seen_ids:
                    continue
                if child_id:
                    seen_ids.add(child_id)
                all_blocks.append(block)

                if block.get("has_children"):
                    if not child_id:
                        raise RuntimeError(f"Notion child block under {block_id} has no id")
                    children = await self._fetch_blocks_recursive(
                        notion, child_id, depth + 1, max_depth, seen_ids
                    )
                    all_blocks.extend(children)

            if not response.get("has_more"):
                break
            next_cursor = response.get("next_cursor")
            if not next_cursor or next_cursor == start_cursor:
                raise RuntimeError(f"Notion pagination stopped before completing block {block_id}")
            start_cursor = next_cursor

        return all_blocks

    def _blocks_to_text(self, blocks: list[dict], indent: str = "") -> str:
        """Convert Notion blocks to plain text, preserving headings, lists, todos, quotes, code."""

        def _rich_text(block: dict) -> str:
            """Extract rich text from a block."""
            block_type = block.get("type", "")
            rt = block.get(block_type, {}).get("rich_text", [])
            return "".join(t.get("plain_text", "") for t in rt)

        text_parts = []
        for block in blocks:
            block_type = block.get("type", "")

            if block_type in ("paragraph", "heading_1", "heading_2", "heading_3"):
                line = _rich_text(block)
                if block_type.startswith("heading"):
                    prefix = "#" * int(block_type[-1])
                    line = f"\n{prefix} {line}\n"
                text_parts.append(indent + line)

            elif block_type == "bulleted_list_item":
                line = _rich_text(block)
                text_parts.append(f"{indent}- {line}")

            elif block_type == "numbered_list_item":
                line = _rich_text(block)
                text_parts.append(f"{indent}1. {line}")

            elif block_type == "to_do":
                line = _rich_text(block)
                checked = block.get("to_do", {}).get("checked", False)
                text_parts.append(f"{indent}- [{'x' if checked else ' '}] {line}")

            elif block_type == "quote":
                line = _rich_text(block)
                text_parts.append(f"{indent}> {line}")

            elif block_type == "code":
                rt = block.get("code", {}).get("rich_text", [])
                code = "".join(t.get("plain_text", "") for t in rt)
                lang = block.get("code", {}).get("language", "")
                lang_str = f"{lang}\n" if lang else ""
                text_parts.append(f"{indent}```{lang_str}{code}\n{indent}```")

            elif block_type == "callout":
                icon = block.get("callout", {}).get("icon", {})
                icon_text = icon.get("emoji", "") if isinstance(icon, dict) else ""
                line = _rich_text(block)
                text_parts.append(f"{indent}{icon_text} {line}".strip())

            elif block_type == "toggle":
                line = _rich_text(block)
                text_parts.append(f"{indent}> {line}")

            elif block_type == "image":
                caption = block.get("image", {}).get("caption", [])
                cap_text = "".join(t.get("plain_text", "") for t in caption)
                img_url = block.get("image", {}).get("file", {}).get("url") or block.get("image", {}).get("external", {}).get("url", "")
                text_parts.append(f"{indent}[Image: {cap_text or img_url}]")

            elif block_type == "divider":
                text_parts.append(f"{indent}---")

            elif block_type == "bookmark":
                bookmark_url = block.get("bookmark", {}).get("url", "")
                caption = block.get("bookmark", {}).get("caption", [])
                cap_text = "".join(t.get("plain_text", "") for t in caption)
                text_parts.append(f"{indent}[Bookmark: {cap_text} ({bookmark_url})]")

            elif block_type == "table_row":
                cells = block.get("table_row", {}).get("cells", [])
                cell_text = ["".join(part.get("plain_text", "") for part in cell) for cell in cells]
                text_parts.append(f"{indent}| {' | '.join(cell_text)} |")

            elif block_type == "child_page" or block_type == "child_database":
                title = block.get(block_type, {}).get("title", "")
                text_parts.append(f"{indent}[{block_type}: {title}]")

            else:
                # Generic fallback: try to extract text
                line = _rich_text(block)
                if line.strip():
                    text_parts.append(f"{indent}{line}")

        return "\n".join(text_parts)

    def _normalize_content(self, text: str) -> str:
        """Normalize content: strip excessive whitespace, ensure clean text."""
        if not text:
            return ""
        # Collapse multiple newlines
        import re

        text = re.sub(r"\n{3,}", "\n\n", text)
        # Collapse multiple spaces
        text = re.sub(r" {2,}", " ", text)
        return text.strip()

    @staticmethod
    def _extract_title(properties: dict) -> str:
        """Extract page title from Notion properties."""
        # Try the "Name" or "title" property first
        for prop_name, prop_value in properties.items():
            if prop_value.get("type") == "title":
                title_parts = prop_value.get("title", [])
                return "".join(t.get("plain_text", "") for t in title_parts)

        # Fallback: use any rich_text property
        for prop_name, prop_value in properties.items():
            if prop_value.get("type") == "rich_text":
                text_parts = prop_value.get("rich_text", [])
                return "".join(t.get("plain_text", "") for t in text_parts)

        return "Untitled"

    @staticmethod
    def _extract_tags(properties: dict) -> list[str]:
        """Extract tags from Notion properties."""
        tags = []
        for prop_name, prop_value in properties.items():
            if prop_value.get("type") == "multi_select":
                for item in prop_value.get("multi_select", []):
                    tags.append(item.get("name", ""))
            elif prop_value.get("type") == "select":
                select_val = prop_value.get("select")
                if select_val:
                    tags.append(select_val.get("name", ""))
        return tags

    @staticmethod
    def _get_embedding_model():
        """Lazy-load sentence-transformers model."""
        from services.search_service import _get_embedding_model as _gem

        return _gem()

    async def _complete_sync(self, sync_state_id: int, db: AsyncSession, processed: int) -> None:
        """Mark sync as completed."""
        sync_state = await db.get(SyncState, sync_state_id)
        if sync_state:
            sync_state.status = "completed"
            sync_state.last_synced_at = datetime.now(timezone.utc)
            sync_state.error_message = None
            await db.commit()
        logger.info(f"Notion sync completed: {processed} pages processed")

    async def _fail_sync(self, sync_state_id: int, error: str) -> None:
        """Mark sync as failed."""
        async with async_session_factory() as db:
            sync_state = await db.get(SyncState, sync_state_id)
            if sync_state:
                sync_state.status = "failed"
                sync_state.error_message = error
                await db.commit()
        logger.error(f"Notion sync failed: {error}")
