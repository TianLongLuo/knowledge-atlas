"""Pydantic schemas for API request/response validation."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


# ── Auth ────────────────────────────────────────────────────────────


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=1024)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


# ── Document ────────────────────────────────────────────────────────


class DocumentBase(BaseModel):
    source_type: str
    source_id: str | None = None
    title: str
    metadata_: dict[str, Any] | None = Field(default_factory=dict, alias="metadata")


class DocumentResponse(BaseModel):
    id: int
    source_type: str
    source_id: str | None = None
    title: str
    raw_content: str | None = None
    normalized_content: str | None = None
    metadata_: dict[str, Any] | None = Field(None, alias="metadata")
    content_hash: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True, "populate_by_name": True}


class DocumentDetailResponse(DocumentResponse):
    chunks: list["ChunkResponse"] = Field(default_factory=list)
    nodes: list["KnowledgeNodeResponse"] = Field(default_factory=list)
    edges: list["KnowledgeEdgeResponse"] = Field(default_factory=list)


class ChunkResponse(BaseModel):
    id: int
    document_id: int
    chunk_index: int
    chunk_text: str
    token_count: int
    chroma_id: str | None = None

    model_config = {"from_attributes": True}


class DocumentListResponse(BaseModel):
    items: list[DocumentResponse]
    total: int
    page: int
    page_size: int


# ── Search ──────────────────────────────────────────────────────────


class SearchResult(BaseModel):
    title: str
    snippet: str
    source: str
    source_type: str | None = None
    similarity_score: float
    document_id: int = 0
    chunk_id: str | None = None
    url: str | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]
    total: int


# ── Agent / Q&A ─────────────────────────────────────────────────────


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=8000)
    top_k: int = Field(default=5, ge=1, le=20)
    session_id: str | None = Field(default=None, max_length=128)
    document_id: int | None = None
    mode: Literal["knowledge", "reflection", "socratic"] = "knowledge"


class Citation(BaseModel):
    document_id: int = 0
    document_title: str
    chunk_snippet: str
    source_url: str | None = None
    similarity_score: float


class AskResponse(BaseModel):
    question: str
    answer: str
    citations: list[Citation]
    session_id: str


class AgentStatusResponse(BaseModel):
    """Non-sensitive readiness details for the AI assistant."""

    deepseek_configured: bool
    deepseek_available: bool
    deepseek_error: str | None = None
    vector_store_available: bool
    vector_document_count: int = 0
    model: str


class MemoryLevelStatus(BaseModel):
    level: str
    title: str
    count: int
    description: str


class AgentMemoryStatusResponse(BaseModel):
    session_id: str | None = None
    levels: list[MemoryLevelStatus]
    vector_count: int = 0


class MemoryInsightResponse(BaseModel):
    id: str
    statement: str
    insight_type: str
    confidence: float
    status: str
    evidence_document_ids: list[int] = Field(default_factory=list)
    created_at: datetime | None = None


class MemoryReviewRequest(BaseModel):
    status: Literal["confirmed", "rejected"]


# ── Sync ────────────────────────────────────────────────────────────


class SyncStatusResponse(BaseModel):
    source_type: str
    source_id: str
    status: str
    last_synced_at: datetime | None = None
    error_message: str | None = None


class SyncStartResponse(BaseModel):
    message: str
    source_type: str
    status: str = "started"


# ── Knowledge Graph ─────────────────────────────────────────────────


class KnowledgeNodeResponse(BaseModel):
    node_id: str
    node_type: str
    title: str
    summary: str | None = None
    source_document_id: int | None = None
    importance_score: float = 0.0
    metadata_: dict[str, Any] | None = Field(None, alias="metadata")

    model_config = {"from_attributes": True, "populate_by_name": True}


class KnowledgeEdgeResponse(BaseModel):
    id: int
    source_node_id: str
    target_node_id: str
    relation_type: str
    confidence: float
    reason: str | None = None
    evidence: str | None = None
    confirmed: bool = False

    model_config = {"from_attributes": True}


class NodeWithEdgesResponse(BaseModel):
    node: KnowledgeNodeResponse
    outgoing_edges: list[KnowledgeEdgeResponse]
    incoming_edges: list[KnowledgeEdgeResponse]


# ── Generic ─────────────────────────────────────────────────────────


class ErrorResponse(BaseModel):
    detail: str
