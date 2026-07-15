"""Knowledge Atlas — FastAPI Application.

A RAG-powered knowledge management backend with:
- PostgreSQL + ChromaDB hybrid storage
- Notion synchronization
- Hybrid search (keyword + vector)
- AI Q&A with DeepSeek
- Knowledge graph nodes and edges
"""

from __future__ import annotations

import logging
import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from database import Base, engine
from routers import agent, auth, dashboard, documents, graph, notes, search, sync

# ── Logging ─────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("knowledge-atlas")


async def _run_corpus_analysis() -> None:
    """Run identity profile extraction after sync, best-effort."""
    try:
        from openai import AsyncOpenAI

        from database import async_session_factory

        if not settings.deepseek_api_key:
            return
        async with async_session_factory() as session:
            from routers.agent import build_identity_profile

            client = AsyncOpenAI(
                api_key=settings.deepseek_api_key,
                base_url=settings.deepseek_base_url,
                timeout=min(settings.deepseek_timeout_seconds, 30),
                max_retries=1,
            )
            result = await build_identity_profile(client, session)
            if result.get("new_insights", 0) > 0:
                logger.info(
                    "Corpus analysis: %d new identity insights extracted",
                    result["new_insights"],
                )
    except Exception:
        logger.exception("Corpus analysis failed (non-fatal)")


async def _run_automatic_notion_sync() -> None:
    """Run Notion sync on a safe interval without requiring a UI click. Broadcasts SSE events."""
    from sqlalchemy import select

    from database import async_session_factory
    from models import SyncState
    from services.notion_sync import NotionSyncService
    from routers.notes import broadcast_sync_event

    while True:
        try:
            async with async_session_factory() as session:
                running = await session.execute(
                    select(SyncState).where(
                        SyncState.source_type == "notion",
                        SyncState.status == "running",
                    )
                )
                if running.scalar_one_or_none() is None:
                    from services.note_service import note_service

                    retries = await note_service.retry_failed_notion_writebacks(session)
                    if retries["attempted"]:
                        logger.info(
                            "Retried %d Notion write-backs: %d completed, %d still failed",
                            retries["attempted"], retries["completed"], retries["failed"],
                        )
                    result = await session.execute(
                        select(SyncState).where(
                            SyncState.source_type == "notion",
                            SyncState.source_id == settings.notion_database_id,
                        )
                    )
                    state = result.scalar_one_or_none()
                    if state is None:
                        state = SyncState(source_type="notion", source_id=settings.notion_database_id)
                        session.add(state)
                    state.status = "running"
                    state.error_message = None
                    await session.commit()
                    await session.refresh(state)
                    broadcast_sync_event("sync_start", {
                        "source_type": "notion",
                        "sync_state_id": state.id,
                        "auto": True,
                    })
                    try:
                        await NotionSyncService().sync_all(state.id)
                        broadcast_sync_event("sync_complete", {
                            "source_type": "notion",
                            "sync_state_id": state.id,
                        })
                        # After sync, refresh the identity profile
                        await _run_corpus_analysis()
                    except Exception as sync_exc:
                        broadcast_sync_event("sync_failure", {
                            "source_type": "notion",
                            "sync_state_id": state.id,
                            "error": str(sync_exc),
                        })
                        raise
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Automatic Notion sync failed")
        await asyncio.sleep(settings.notion_auto_sync_interval_minutes * 60)


# ── Application lifecycle ───────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: create tables. Shutdown: dispose engine."""
    logger.info("Starting Knowledge Atlas backend...")

    # Create all tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables verified/created")

    # Verify ChromaDB connection
    try:
        from database import get_chroma_collection

        col = get_chroma_collection()
        count = col.count()
        logger.info(f"ChromaDB connected — collection has {count} items")
    except Exception as e:
        logger.warning(f"ChromaDB connection issue: {e}")

    sync_task: asyncio.Task | None = None
    if (
        settings.notion_auto_sync_enabled
        and settings.notion_api_key
        and settings.notion_database_id
    ):
        sync_task = asyncio.create_task(_run_automatic_notion_sync())
        logger.info(
            "Automatic Notion sync enabled every %d minutes",
            settings.notion_auto_sync_interval_minutes,
        )

    yield

    if sync_task:
        sync_task.cancel()
        with suppress(asyncio.CancelledError):
            await sync_task

    await engine.dispose()
    logger.info("Knowledge Atlas backend shut down")


# ── App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="Knowledge Atlas API",
    description="RAG-powered knowledge management with hybrid search and AI Q&A",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ─────────────────────────────────────────────────────────

app.include_router(auth.router)
app.include_router(documents.router)
app.include_router(search.router)
app.include_router(notes.router)
app.include_router(sync.router)
app.include_router(agent.router)
app.include_router(graph.router)
app.include_router(dashboard.router)


@app.get("/api/ready")
async def readiness_check():
    """Dependency-aware readiness probe for reverse proxies/orchestrators."""
    database_ok = False
    chroma_ok = False
    try:
        from sqlalchemy import text

        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        database_ok = True
    except Exception:
        logger.exception("PostgreSQL readiness check failed")
    try:
        from database import get_chroma_collection

        get_chroma_collection().count()
        chroma_ok = True
    except Exception:
        logger.exception("ChromaDB readiness check failed")

    from fastapi.responses import JSONResponse

    ready = database_ok and chroma_ok
    return JSONResponse(
        status_code=200 if ready else 503,
        content={"status": "ready" if ready else "not_ready", "postgres": database_ok, "chroma": chroma_ok},
    )


# ── Health check ────────────────────────────────────────────────────


@app.get("/api/health")
async def health_check():
    """Simple health check endpoint."""
    try:
        from database import get_chroma_collection

        col = get_chroma_collection()
        chroma_count = col.count()
    except Exception:
        chroma_count = -1

    return {
        "status": "ok",
        "version": "1.0.0",
        "chroma_items": chroma_count,
        "notion_configured": bool(settings.notion_api_key and settings.notion_database_id),
        "deepseek_configured": bool(settings.deepseek_api_key),
    }
