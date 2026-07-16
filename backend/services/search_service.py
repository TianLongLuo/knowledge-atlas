"""Search service — hybrid search across PostgreSQL and ChromaDB."""

from __future__ import annotations

import logging
from datetime import datetime, time

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_chroma_collection
from models import Document
from schemas import SearchResult
from utils import (
    canonical_document_key,
    document_display_title,
    dominant_group,
    legacy_document_key,
    normalized_tags,
    pseudo_id,
)

logger = logging.getLogger(__name__)

# Lazy-loaded embedding model
_embedding_model = None
_chroma_cache = None  # cache all chroma docs for text search


def invalidate_search_cache() -> None:
    """Invalidate the in-process text index after vector-store mutations."""
    global _chroma_cache
    _chroma_cache = None


def _get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        from sentence_transformers import SentenceTransformer
        _embedding_model = SentenceTransformer(settings.embedding_model)
    return _embedding_model


def _get_chroma_docs():
    """Get all documents from ChromaDB (cached)."""
    global _chroma_cache
    if _chroma_cache is None:
        try:
            collection = get_chroma_collection()
            result = collection.get(include=["documents", "metadatas"])
            _chroma_cache = []
            if result["ids"]:
                for i, cid in enumerate(result["ids"]):
                    _chroma_cache.append({
                        "id": cid,
                        "document": (result["documents"][i] or "") if result["documents"] else "",
                        "metadata": (result["metadatas"][i] or {}) if result["metadatas"] else {},
                    })
        except Exception as e:
            logger.error(f"Failed to load ChromaDB docs: {e}")
            _chroma_cache = []
    return _chroma_cache


class SearchService:
    """Combined keyword (PostgreSQL + ChromaDB text) + vector (ChromaDB) search."""

    async def search(
        self,
        query: str,
        search_type: str = "hybrid",
        source_type: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        document_id: int | None = None,
        top_k: int = 10,
        db: AsyncSession | None = None,
    ) -> list[SearchResult]:
        results: list[SearchResult] = []

        if search_type in ("hybrid", "keyword"):
            # PostgreSQL keyword search
            if db is not None:
                kw = await self._keyword_search(query, source_type, date_from, date_to, top_k, db)
                results.extend(kw)
            # ChromaDB text search (fallback for existing collection)
            ct = self._chromadb_text_search(query, source_type, top_k)
            # Merge, deduplicate by (document_id, chunk_id)
            seen = {(r.document_id, r.chunk_id) for r in results}
            for r in ct:
                if (r.document_id, r.chunk_id) not in seen:
                    results.append(r)
                    seen.add((r.document_id, r.chunk_id))

        if search_type in ("hybrid", "vector"):
            vr = await self._vector_search(query, source_type, date_from, date_to, document_id, top_k, db)
            seen = {(r.document_id, r.chunk_id) for r in results}
            for r in vr:
                if (r.document_id, r.chunk_id) not in seen:
                    results.append(r)

        results.sort(key=lambda r: r.similarity_score, reverse=True)
        deduplicated: list[SearchResult] = []
        seen_content: set[str] = set()
        for result in results:
            key = canonical_document_key(result.title, result.snippet)
            if key and key in seen_content:
                continue
            if key:
                seen_content.add(key)
            deduplicated.append(result)
            if len(deduplicated) >= top_k:
                break
        return deduplicated

    async def _keyword_search(
        self, query: str, source_type: str | None, date_from: str | None,
        date_to: str | None, limit: int, db: AsyncSession,
    ) -> list[SearchResult]:
        doc_query = select(Document)
        if source_type:
            doc_query = doc_query.where(Document.source_type == source_type)
        if date_from:
            doc_query = doc_query.where(Document.created_at >= datetime.fromisoformat(date_from))
        if date_to:
            parsed_to = datetime.fromisoformat(date_to)
            if len(date_to) <= 10:
                parsed_to = datetime.combine(parsed_to.date(), time.max)
            doc_query = doc_query.where(Document.created_at <= parsed_to)
        result = await db.execute(doc_query)
        candidates = result.scalars().all()

        query_lower = query.casefold().strip()
        docs: list[Document] = []
        seen_content: set[str] = set()
        for doc in candidates:
            metadata = doc.metadata_ or {}
            content = doc.normalized_content or doc.raw_content or ""
            canonical_key = canonical_document_key(doc.title, content)
            if canonical_key is None or canonical_key in seen_content:
                continue
            searchable = "\n".join([
                doc.title,
                content,
                dominant_group(content, doc.title, metadata),
                " ".join(normalized_tags(metadata)),
            ]).casefold()
            if query_lower in searchable:
                docs.append(doc)
                seen_content.add(canonical_key)
            if len(docs) >= limit:
                break

        results = []
        for doc in docs:
            content = doc.normalized_content or doc.raw_content or ""
            tags = normalized_tags(doc.metadata_ or {})
            snippet = self._extract_snippet(content, query)
            tag_match = query_lower in {tag.casefold() for tag in tags}
            category_match = query_lower == dominant_group(content, doc.title, doc.metadata_ or {}).casefold()
            if tag_match:
                snippet = f"Tag: {query} · {snippet}"
            results.append(SearchResult(
                title=document_display_title(doc.title, content),
                snippet=snippet, source=doc.source_type,
                source_type=doc.source_type,
                similarity_score=0.98 if tag_match else 0.92 if category_match else 0.5,
                document_id=doc.id, chunk_id=None,
                url=(doc.metadata_ or {}).get("url"),
            ))
        return results

    def _chromadb_text_search(
        self, query: str, source_type: str | None, limit: int = 10
    ) -> list[SearchResult]:
        """Text search in existing ChromaDB collection (no re-embedding needed)."""
        try:
            docs = _get_chroma_docs()
            query_lower = query.lower()
            matches = []
            for doc in docs:
                text = doc["document"]
                meta = doc["metadata"]
                doc_source = meta.get("source")
                if source_type and doc_source != source_type:
                    continue
                text_lower = text.lower()
                title = meta.get("title", "")
                tags = normalized_tags(meta)
                category = dominant_group(text, title, meta)
                metadata_text = f"{category} {' '.join(tags)}".casefold()
                if query_lower in text_lower or query_lower in title.lower() or query_lower in metadata_text:
                    # Score by position: earlier match = higher score
                    pos = text_lower.find(query_lower)
                    if query_lower in {tag.casefold() for tag in tags}:
                        score = 0.98
                    elif query_lower == category.casefold():
                        score = 0.92
                    else:
                        score = 1.0 if pos == 0 else max(0.3, 1.0 - max(pos, 0) / max(len(text_lower), 1))
                    matches.append((score, doc, text, meta, title, doc_source))

            matches.sort(key=lambda x: x[0], reverse=True)
            results = []
            seen_documents: set[int] = set()
            seen_content: set[str] = set()
            for score, doc, text, meta, title, doc_source in matches:
                logical_id = pseudo_id(legacy_document_key(doc["id"], meta, text))
                canonical_key = canonical_document_key(title, text)
                if logical_id in seen_documents or canonical_key is None or canonical_key in seen_content:
                    continue
                seen_documents.add(logical_id)
                seen_content.add(canonical_key)
                snippet = self._extract_snippet(text, query)
                results.append(SearchResult(
                    title=document_display_title(title, text),
                    snippet=snippet,
                    source=doc_source or source_type or "chromadb",
                    source_type=doc_source or source_type,
                    similarity_score=round(score, 4),
                    document_id=logical_id,
                    chunk_id=doc["id"],
                    url=meta.get("url") or meta.get("notion_page_id"),
                ))
                if len(results) >= limit:
                    break
            return results
        except Exception as e:
            logger.error(f"ChromaDB text search error: {e}")
            return []

    async def _vector_search(
        self, query: str, source_type: str | None, date_from: str | None,
        date_to: str | None, document_id: int | None, limit: int, db: AsyncSession | None,
    ) -> list[SearchResult]:
        try:
            model = _get_embedding_model()
            query_embedding = model.encode(query).tolist()
            collection = get_chroma_collection()
            filters = []
            if source_type:
                filters.append({"source": source_type})
            # Document-scoped retrieval is filtered after querying. Legacy notes
            # have no document_id metadata, while canonical writers historically
            # used both strings and integers; a Chroma where clause would miss
            # one of those representations.
            where_filter = None if not filters else filters[0] if len(filters) == 1 else {"$and": filters}
            candidate_count = collection.count() if document_id is not None else min(max(limit * 4, limit), collection.count())
            results = collection.query(
                query_embeddings=[query_embedding], n_results=candidate_count,
                where=where_filter, include=["documents", "metadatas", "distances"],
            )

            search_results = []
            seen_documents: set[int] = set()
            seen_content: set[str] = set()
            if results["ids"] and results["ids"][0]:
                for i, chroma_id in enumerate(results["ids"][0]):
                    metadata = (results["metadatas"][0] or [{}])[i] if results["metadatas"][0] else {}
                    distance = (results["distances"][0] or [1.0])[i] if results["distances"][0] else 1.0
                    document = (results["documents"][0] or [""])[i] if results["documents"][0] else ""
                    raw_date = metadata.get("created_at") or metadata.get("timestamp")
                    if raw_date and (date_from or date_to):
                        try:
                            item_date = datetime.fromisoformat(str(raw_date).replace("Z", "+00:00")).date()
                            if date_from and item_date < datetime.fromisoformat(date_from).date():
                                continue
                            if date_to and item_date > datetime.fromisoformat(date_to).date():
                                continue
                        except ValueError:
                            logger.debug("Ignoring malformed Chroma date: %s", raw_date)
                    similarity = 1.0 - float(distance)
                    doc_id = metadata.get("document_id", 0)
                    try:
                        doc_id = int(doc_id)
                    except (ValueError, TypeError):
                        doc_id = 0
                    # Legacy imports predate canonical PostgreSQL IDs.  Giving
                    # every one of them document_id=0 made the agent's diversity
                    # pass collapse the whole knowledge base into one note.
                    # The document API uses the same stable negative ID, so these
                    # citations remain directly readable.
                    if doc_id == 0:
                        doc_id = pseudo_id(legacy_document_key(chroma_id, metadata, document))
                    if document_id is not None and doc_id != document_id:
                        continue
                    canonical_key = canonical_document_key(
                        str(metadata.get("title") or "Untitled"),
                        document,
                    )
                    if doc_id in seen_documents or canonical_key is None or canonical_key in seen_content:
                        continue
                    seen_documents.add(doc_id)
                    seen_content.add(canonical_key)
                    search_results.append(SearchResult(
                        title=document_display_title(
                            str(metadata.get("title") or ""),
                            document,
                        ),
                        snippet=document[:500] if document else "",
                        source=metadata.get("source", source_type or "unknown"),
                        source_type=metadata.get("source", source_type),
                        similarity_score=round(similarity, 4),
                        document_id=doc_id, chunk_id=chroma_id,
                        url=metadata.get("url"),
                    ))
                    if len(search_results) >= limit:
                        break
            return search_results
        except Exception as e:
            logger.error(f"Vector search error: {e}")
            return []

    @staticmethod
    def _extract_snippet(text: str, query: str, window: int = 150) -> str:
        if not text:
            return ""
        text_lower = text.lower()
        query_lower = query.lower()
        pos = text_lower.find(query_lower)
        if pos == -1:
            for word in query_lower.split():
                pos = text_lower.find(word)
                if pos != -1:
                    break
        if pos == -1:
            return text[:window * 2]
        start = max(0, pos - window)
        end = min(len(text), pos + len(query) + window)
        snippet = text[start:end]
        if start > 0:
            snippet = "..." + snippet
        if end < len(text):
            snippet += "..."
        return snippet
