"""SQLAlchemy ORM models for Knowledge Atlas."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_uuid() -> str:
    return str(uuid.uuid4())


# ── User ────────────────────────────────────────────────────────────


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(128), unique=True, nullable=False, index=True)
    hashed_password = Column(String(256), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ── Document ────────────────────────────────────────────────────────


class Document(Base):
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_type = Column(
        String(64), nullable=False, index=True
    )  # e.g. "notion", "manual", "file"
    source_id = Column(
        String(256), nullable=True, index=True
    )  # external ID in source system
    title = Column(String(1024), nullable=False)
    raw_content = Column(Text, nullable=True)
    normalized_content = Column(Text, nullable=True)
    metadata_ = Column("metadata", JSON, default=dict)
    content_hash = Column(String(128), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    chunks = relationship("DocumentChunk", back_populates="document", cascade="all, delete-orphan")
    nodes = relationship("KnowledgeNode", back_populates="document", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("source_type", "source_id", name="uq_document_source"),
    )


# ── Document Chunk ──────────────────────────────────────────────────


class DocumentChunk(Base):
    """A text chunk within a document, with its own ChromaDB entry."""

    __tablename__ = "document_chunks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(Integer, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True)
    chunk_index = Column(Integer, nullable=False)
    chunk_text = Column(Text, nullable=False)
    chunk_hash = Column(String(128), nullable=True)
    chroma_id = Column(String(256), nullable=True, index=True)
    token_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    document = relationship("Document", back_populates="chunks")

    __table_args__ = (
        UniqueConstraint("document_id", "chunk_index", name="uq_chunk_doc_index"),
    )


# ── Knowledge Node ──────────────────────────────────────────────────


class KnowledgeNode(Base):
    __tablename__ = "knowledge_nodes"

    node_id = Column(String(128), primary_key=True, default=_new_uuid)
    node_type = Column(String(64), nullable=False, default="concept")
    title = Column(String(1024), nullable=False)
    summary = Column(Text, nullable=True)
    source_document_id = Column(
        Integer, ForeignKey("documents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    importance_score = Column(Float, default=0.0)
    metadata_ = Column("metadata", JSON, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    document = relationship("Document", back_populates="nodes")
    outgoing_edges = relationship(
        "KnowledgeEdge",
        foreign_keys="KnowledgeEdge.source_node_id",
        back_populates="source_node",
        cascade="all, delete-orphan",
    )
    incoming_edges = relationship(
        "KnowledgeEdge",
        foreign_keys="KnowledgeEdge.target_node_id",
        back_populates="target_node",
        cascade="all, delete-orphan",
    )


# ── Knowledge Edge ──────────────────────────────────────────────────


class KnowledgeEdge(Base):
    __tablename__ = "knowledge_edges"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_node_id = Column(
        String(128), ForeignKey("knowledge_nodes.node_id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_node_id = Column(
        String(128), ForeignKey("knowledge_nodes.node_id", ondelete="CASCADE"), nullable=False, index=True
    )
    relation_type = Column(String(128), nullable=False)
    confidence = Column(Float, default=0.5)
    reason = Column(Text, nullable=True)
    evidence = Column(Text, nullable=True)
    confirmed = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    source_node = relationship("KnowledgeNode", foreign_keys=[source_node_id], back_populates="outgoing_edges")
    target_node = relationship("KnowledgeNode", foreign_keys=[target_node_id], back_populates="incoming_edges")

    __table_args__ = (
        UniqueConstraint(
            "source_node_id", "target_node_id", "relation_type", name="uq_edge"
        ),
    )


# ── Sync State ──────────────────────────────────────────────────────


class SyncState(Base):
    __tablename__ = "sync_states"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source_type = Column(String(64), nullable=False)
    source_id = Column(String(256), nullable=False)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(
        String(32), default="pending"
    )  # pending, running, completed, failed
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("source_type", "source_id", name="uq_sync_state"),
    )


# ── Agent Memory ────────────────────────────────────────────────────


class AgentMemory(Base):
    """Persistent, inspectable memory used by the RAG assistant."""

    __tablename__ = "agent_memories"

    id = Column(UUID(as_uuid=False), primary_key=True, default=_new_uuid)
    session_id = Column(String(128), nullable=False, index=True)
    level = Column(String(8), nullable=False, index=True)  # L0 dialogue, L1 retrieved knowledge
    role = Column(String(32), nullable=False)
    content = Column(Text, nullable=False)
    metadata_ = Column("metadata", JSON, default=dict)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    __table_args__ = (Index("ix_agent_memory_session_level", "session_id", "level"),)
