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
            # Merge, deduplicate by title
            seen = {r.title for r in results}
            for r in ct:
                if r.title not in seen:
                    results.append(r)
                    seen.add(r.title)

        if search_type in ("hybrid", "vector"):
            vr = await self._vector_search(query, source_type, date_from, date_to, top_k, db)
            seen = {(r.document_id, r.chunk_id) for r in results}
            for r in vr:
                if (r.document_id, r.chunk_id) not in seen:
                    results.append(r)

        results.sort(key=lambda r: r.similarity_score, reverse=True)
        return results[:top_k]

    async def _keyword_search(
        self, query: str, source_type: str | None, date_from: str | None,
        date_to: str | None, limit: int, db: AsyncSession,
    ) -> list[SearchResult]:
        pattern = f"%{query}%"
        doc_query = select(Document).where(
            Document.normalized_content.ilike(pattern) | Document.title.ilike(pattern)
        )
        if source_type:
            doc_query = doc_query.where(Document.source_type == source_type)
        if date_from:
            doc_query = doc_query.where(Document.created_at >= datetime.fromisoformat(date_from))
        if date_to:
            parsed_to = datetime.fromisoformat(date_to)
            if len(date_to) <= 10:
                parsed_to = datetime.combine(parsed_to.date(), time.max)
            doc_query = doc_query.where(Document.created_at <= parsed_to)
        doc_query = doc_query.limit(limit)
        result = await db.execute(doc_query)
        docs = result.scalars().all()

        results = []
        for doc in docs:
            snippet = self._extract_snippet(doc.normalized_content or doc.raw_content or "", query)
            results.append(SearchResult(
                title=doc.title, snippet=snippet, source=doc.source_type,
                source_type=doc.source_type, similarity_score=0.5,
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
                if query_lower in text_lower or query_lower in title.lower():
                    # Score by position: earlier match = higher score
                    pos = text_lower.find(query_lower)
                    score = 1.0 if pos == 0 else max(0.3, 1.0 - pos / max(len(text_lower), 1))
                    matches.append((score, doc, text, meta, title))

            matches.sort(key=lambda x: x[0], reverse=True)
            results = []
            for score, doc, text, meta, title in matches[:limit]:
                snippet = self._extract_snippet(text, query)
                results.append(SearchResult(
                    title=title or "Untitled",
                    snippet=snippet,
                    source=doc_source or source_type or "chromadb",
                    source_type=doc_source or source_type,
                    similarity_score=round(score, 4),
                    document_id=0,
                    chunk_id=doc["id"],
                    url=meta.get("url") or meta.get("notion_page_id"),
                ))
            return results
        except Exception as e:
            logger.error(f"ChromaDB text search error: {e}")
            return []

    async def _vector_search(
        self, query: str, source_type: str | None, date_from: str | None,
        date_to: str | None, limit: int, db: AsyncSession | None,
    ) -> list[SearchResult]:
        try:
            model = _get_embedding_model()
            query_embedding = model.encode(query).tolist()
            collection = get_chroma_collection()
            where_filter = {"source": source_type} if source_type else None
            results = collection.query(
                query_embeddings=[query_embedding], n_results=limit,
                where=where_filter, include=["documents", "metadatas", "distances"],
            )

            search_results = []
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
                    search_results.append(SearchResult(
                        title=metadata.get("title", "Untitled"),
                        snippet=document[:500] if document else "",
                        source=metadata.get("source", source_type or "unknown"),
                        source_type=metadata.get("source", source_type),
                        similarity_score=round(similarity, 4),
                        document_id=doc_id, chunk_id=chroma_id,
                        url=metadata.get("url"),
                    ))
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
