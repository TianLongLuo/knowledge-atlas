"""Database engine and session management.

Provides async SQLAlchemy engine + session factory for PostgreSQL,
and a ChromaDB client for the vector store.
"""

from __future__ import annotations

import chromadb
from chromadb.config import Settings as ChromaSettings
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from config import settings

# ── PostgreSQL (async) ──────────────────────────────────────────────

engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True,
)

async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    """Declarative base for all SQLAlchemy models."""


# ── ChromaDB ────────────────────────────────────────────────────────

chroma_client = chromadb.PersistentClient(
    path=settings.chroma_data_path,
    settings=ChromaSettings(anonymized_telemetry=False),
)

# Get or create the collection
_chroma_collection: chromadb.Collection | None = None


def get_chroma_collection() -> chromadb.Collection:
    """Return a reference to the ChromaDB collection, creating it if needed."""
    global _chroma_collection
    if _chroma_collection is None:
        try:
            _chroma_collection = chroma_client.get_collection(
                name=settings.chroma_collection_name
            )
        except Exception:
            _chroma_collection = chroma_client.create_collection(
                name=settings.chroma_collection_name,
                metadata={"hnsw:space": "cosine"},
            )
    return _chroma_collection


# ── Dependency helpers ──────────────────────────────────────────────


async def get_db() -> AsyncSession:  # type: ignore[misc]
    """FastAPI dependency: yields an async DB session."""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
