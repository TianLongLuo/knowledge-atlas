"""Search router — hybrid search across PostgreSQL and ChromaDB."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from schemas import SearchResponse
from services.search_service import SearchService

router = APIRouter(prefix="/api/search", tags=["search"])
_search_service = SearchService()


@router.get("", response_model=SearchResponse)
async def search(
    q: str = Query(..., min_length=1, description="Search query"),
    type: str = Query(default="hybrid", description="Search type: hybrid, keyword, vector"),
    source_type: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    top_k: int = Query(default=10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Hybrid search across PostgreSQL (ILIKE) and ChromaDB (vector similarity).

    - **q**: Search query string
    - **type**: "hybrid" (default), "keyword" (text only), or "vector" (semantic only)
    - **source_type**: Filter by source_type (e.g., "notion")
    - **date_from / date_to**: Filter by creation date (ISO format)
    - **top_k**: Number of results to return
    """
    results = await _search_service.search(
        query=q,
        search_type=type,
        source_type=source_type,
        date_from=date_from,
        date_to=date_to,
        top_k=top_k,
        db=db,
    )
    return SearchResponse(query=q, results=results, total=len(results))
