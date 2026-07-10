"""Sync router — Notion sync trigger and status."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from config import settings
from database import get_db
from models import SyncState
from schemas import SyncStartResponse, SyncStatusResponse

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("/notion/start", response_model=SyncStartResponse)
async def start_notion_sync(
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Trigger a full sync from Notion.

    Runs in the background — use GET /api/sync/status to check progress.
    """
    if not settings.notion_api_key:
        raise HTTPException(
            status_code=400,
            detail="NOTION_API_KEY is not configured",
        )
    if not settings.notion_database_id:
        raise HTTPException(
            status_code=400,
            detail="NOTION_DATABASE_ID is not configured. Set it in .env",
        )

    # Check if a sync is already running
    existing = await db.execute(
        select(SyncState).where(
            SyncState.source_type == "notion",
            SyncState.status == "running",
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail="A Notion sync is already in progress",
        )

    # Reuse the source state; (source_type, source_id) is intentionally unique.
    state_result = await db.execute(
        select(SyncState).where(
            SyncState.source_type == "notion",
            SyncState.source_id == settings.notion_database_id,
        )
    )
    sync_state = state_result.scalar_one_or_none()
    if sync_state is None:
        sync_state = SyncState(source_type="notion", source_id=settings.notion_database_id)
        db.add(sync_state)
    sync_state.status = "running"
    sync_state.error_message = None
    await db.commit()
    await db.refresh(sync_state)

    # Trigger background sync
    from services.notion_sync import NotionSyncService

    sync_service = NotionSyncService()
    background_tasks.add_task(_run_sync, sync_service, sync_state.id)

    return SyncStartResponse(
        message="Notion sync started",
        source_type="notion",
        status="running",
    )


async def _run_sync(sync_service, sync_state_id: int):
    """Background task wrapper for the sync."""
    try:
        await sync_service.sync_all(sync_state_id)
    except Exception as e:
        import logging

        logging.getLogger(__name__).error(f"Notion sync failed: {e}")


@router.get("/status", response_model=list[SyncStatusResponse])
async def get_sync_status(
    source_type: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Get sync status for all or a specific source type."""
    query = select(SyncState)
    if source_type:
        query = query.where(SyncState.source_type == source_type)
    query = query.order_by(SyncState.updated_at.desc())

    result = await db.execute(query)
    states = result.scalars().all()

    return [
        SyncStatusResponse(
            source_type=s.source_type,
            source_id=s.source_id,
            status=s.status,
            last_synced_at=s.last_synced_at,
            error_message=s.error_message,
        )
        for s in states
    ]
