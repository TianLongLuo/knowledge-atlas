"""Scalable semantic graph API backed by Chroma's ANN index."""

from __future__ import annotations

import logging
import math
import re
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import get_current_user
from config import settings
from database import get_chroma_collection
from utils import (
    pseudo_id as _pseudo_id,
    normalized_source_type,
    normalized_tags,
    dominant_group,
    content_snippet,
    display_label,
    legacy_document_key,
)

logger = logging.getLogger("knowledge-atlas.graph")
router = APIRouter(prefix="/api/graph", tags=["graph"])
_graph_cache: dict[tuple[int, float, int, int], tuple[float, "GraphResponse"]] = {}


def invalidate_graph_cache() -> None:
    _graph_cache.clear()


class GraphNode(BaseModel):
    id: str
    label: str
    group: str
    size: float = 10
    snippet: str = ""
    document_id: int
    source: str = "unknown"
    node_type: str = "Unknown"
    tags: list[str] = Field(default_factory=list)
    degree: int = 0


class GraphEdge(BaseModel):
    source: str
    target: str
    weight: float = Field(ge=0, le=1)
    label: str = "semantic"
    edge_type: str = "semantic"


class GraphStats(BaseModel):
    node_count: int
    edge_count: int
    isolated_count: int
    groups: dict[str, int]
    types: dict[str, int] = Field(default_factory=dict)
    tags: dict[str, int] = Field(default_factory=dict)


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    stats: GraphStats


def _empty_response() -> GraphResponse:
    return GraphResponse(
        nodes=[],
        edges=[],
        stats=GraphStats(node_count=0, edge_count=0, isolated_count=0, groups={}),
    )


def _node_identity(chroma_id: str, metadata: dict, content: str = "") -> tuple[str, int]:
    """Collapse all chunks belonging to one document into one graph node."""
    raw_document_id = metadata.get("document_id")
    try:
        document_id = int(raw_document_id)
        return f"document:{document_id}", document_id
    except (TypeError, ValueError):
        logical_key = legacy_document_key(chroma_id, metadata, content)
        return f"legacy:{logical_key}", _pseudo_id(logical_key)


def _proposal_edges(proposals: dict[tuple[str, str], dict[str, object]], max_edges: int) -> list[GraphEdge]:
    """Turn every threshold-qualified neighbour proposal into a bounded edge list."""
    edges = [
        GraphEdge(
            source=pair[0], target=pair[1], weight=round(float(value["weight"]), 4),
            label=str(value.get("label") or f"semantic {float(value['weight']):.2f}"),
            edge_type="composite",
        )
        for pair, value in proposals.items()
    ]
    return sorted(edges, key=lambda edge: edge.weight, reverse=True)[:max_edges]


def _normalized_vector(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector] if norm else vector


_TOPIC_FAMILIES = {
    "english-speaking": (
        "英语口语", "口语练习", "英语练习", "英语对话", "口语表达", "跟读",
        "spoken english", "speaking practice", "oral english", "english conversation", "shadowing",
    ),
    "sales": ("销售", "成交", "客户转化", "sales", "closing", "customer conversion"),
    "marketing": ("营销", "推广", "广告投放", "marketing", "promotion", "advertising"),
    "product": ("产品设计", "产品经理", "用户体验", "product design", "product management", "user experience"),
    "reflection": ("反思", "复盘", "自我认知", "reflection", "retrospective", "self awareness"),
}


def _topic_signals(node: GraphNode) -> set[str]:
    """Extract cross-language themes plus useful lexical overlap from a node."""
    combined = " ".join((node.label, node.snippet, *node.tags)).casefold()
    signals = {
        family
        for family, phrases in _TOPIC_FAMILIES.items()
        if any(phrase in combined for phrase in phrases)
    }
    signals.update(
        f"term:{word}"
        for word in re.findall(r"[a-z][a-z0-9-]{3,}", combined)
        if word not in {"this", "that", "with", "from", "have", "about"}
    )
    signals.update(f"tag:{tag.casefold()}" for tag in node.tags)
    return signals


def _composite_link_score(
    semantic: float,
    source: GraphNode,
    target: GraphNode,
    min_similarity: float,
) -> tuple[float, str] | None:
    """Blend meaning, category and tags without allowing metadata-only links."""
    source_tags = {tag.casefold() for tag in source.tags}
    target_tags = {tag.casefold() for tag in target.tags}
    shared_tags = source_tags & target_tags
    all_tags = source_tags | target_tags
    tag_overlap = len(shared_tags) / len(all_tags) if all_tags else 0.0
    same_category = bool(source.group and source.group == target.group)
    shared_topics = _topic_signals(source) & _topic_signals(target)
    strong_topics = {topic for topic in shared_topics if not topic.startswith("term:")}

    # Metadata may strengthen a meaningful relationship, but never create one
    # when the note bodies are semantically far apart.
    eligible = (
        semantic >= min_similarity
        or (shared_tags and semantic >= max(0.18, min_similarity - 0.16))
        or (same_category and semantic >= max(0.22, min_similarity - 0.09))
        or (strong_topics and semantic >= max(0.10, min_similarity - 0.28))
        or (shared_topics and semantic >= max(0.16, min_similarity - 0.22))
    )
    if not eligible:
        return None

    topic_strength = 1.0 if strong_topics else min(1.0, len(shared_topics) / 3)
    score = min(
        1.0,
        semantic * 0.68 + tag_overlap * 0.12
        + (0.06 if same_category else 0.0) + topic_strength * 0.14,
    )
    signals = [f"meaning {semantic:.2f}"]
    if same_category:
        signals.append(f"category {source.group}")
    if shared_tags:
        signals.append("tags " + ", ".join(sorted(shared_tags)[:3]))
    if shared_topics:
        signals.append("topic " + ", ".join(
            topic.removeprefix("term:").removeprefix("tag:")
            for topic in sorted(shared_topics)[:3]
        ))
    return score, " · ".join(signals)


def _build_composite_proposals(
    nodes_by_id: dict[str, GraphNode],
    vectors_by_id: dict[str, list[float]],
    min_similarity: float,
    neighbors: int,
) -> dict[tuple[str, str], dict[str, object]]:
    normalized = {node_id: _normalized_vector(vector) for node_id, vector in vectors_by_id.items()}
    candidates: dict[str, list[tuple[float, str, str]]] = {node_id: [] for node_id in normalized}
    node_ids = list(normalized)
    for source_index, source_id in enumerate(node_ids):
        for target_id in node_ids[source_index + 1:]:
            semantic = max(0.0, min(1.0, sum(
                left * right for left, right in zip(normalized[source_id], normalized[target_id])
            )))
            scored = _composite_link_score(
                semantic, nodes_by_id[source_id], nodes_by_id[target_id], min_similarity
            )
            if scored is None:
                continue
            weight, label = scored
            candidates[source_id].append((weight, target_id, label))
            candidates[target_id].append((weight, source_id, label))

    proposals: dict[tuple[str, str], dict[str, object]] = {}
    for source_id, links in candidates.items():
        for weight, target_id, label in sorted(links, reverse=True)[:neighbors]:
            pair = tuple(sorted((source_id, target_id)))
            existing = proposals.get(pair)
            if existing is None or weight > float(existing["weight"]):
                proposals[pair] = {"weight": weight, "label": label, "directions": {source_id}}
            else:
                directions = existing.get("directions")
                if isinstance(directions, set):
                    directions.add(source_id)
    return proposals


@router.get("/full", response_model=GraphResponse)
async def get_full_graph(
    limit: int = Query(default=settings.graph_default_limit, ge=10, le=500),
    min_similarity: float = Query(default=0.45, ge=0.05, le=0.95),
    neighbors: int = Query(default=settings.graph_neighbors_per_node, ge=2, le=50),
    max_edges: int = Query(default=settings.graph_max_edges, ge=10, le=5000),
    _user: str = Depends(get_current_user),
):
    """Return a document graph blending semantic meaning, categories and tags."""
    cache_key = (limit, round(min_similarity, 3), neighbors, max_edges)
    cached = _graph_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < 30:
        return cached[1]
    try:
        collection = get_chroma_collection()
        # A document may have many chunks. Read a bounded oversample and then
        # aggregate chunks into document-level nodes before querying ANN.
        result = collection.get(
            limit=min(limit * 8, 4000),
            include=["documents", "metadatas", "embeddings"],
        )
        ids = list(result.get("ids") or [])
        if not ids:
            return _empty_response()

        documents = list(result.get("documents") or [""] * len(ids))
        metadatas = list(result.get("metadatas") or [{}] * len(ids))
        raw_embeddings = result.get("embeddings")
        embeddings = []
        if raw_embeddings is not None:
            embeddings = [embedding.tolist() if hasattr(embedding, "tolist") else list(embedding) for embedding in raw_embeddings]

        aggregates: dict[str, dict] = {}
        for index, chroma_id in enumerate(ids):
            metadata = metadatas[index] or {}
            text = documents[index] or ""
            node_id, document_id = _node_identity(chroma_id, metadata, text)
            aggregate = aggregates.setdefault(node_id, {
                "document_id": document_id,
                "title": str(metadata.get("title") or f"Note {index + 1}"),
                "source": str(metadata.get("source") or "chromadb"),
                "metadata": metadata,
                "texts": [],
                "vectors": [],
            })
            if len(aggregate["texts"]) < 4:
                aggregate["texts"].append(text)
            if len(embeddings) == len(ids) and embeddings[index]:
                aggregate["vectors"].append(embeddings[index])

        selected_aggregates = list(aggregates.items())[:limit]
        nodes_by_id: dict[str, GraphNode] = {}
        query_embeddings: list[list[float]] = []
        query_node_ids: list[str] = []
        group_counts: dict[str, int] = {}
        type_counts: dict[str, int] = {}
        tag_counts: dict[str, int] = {}
        for node_id, aggregate in selected_aggregates:
            text = "\n".join(aggregate["texts"])
            title = aggregate["title"]
            metadata = aggregate["metadata"]
            group = dominant_group(text, title, metadata)
            source_type = normalized_source_type(aggregate["source"], metadata)
            tags = normalized_tags(metadata)
            group_counts[group] = group_counts.get(group, 0) + 1
            type_counts[source_type] = type_counts.get(source_type, 0) + 1
            for tag in tags:
                tag_counts[tag] = tag_counts.get(tag, 0) + 1
            nodes_by_id[node_id] = GraphNode(
                id=node_id,
                label=display_label(title),
                group=group,
                snippet=content_snippet(text),
                document_id=aggregate["document_id"],
                source=aggregate["source"],
                node_type=source_type,
                tags=tags,
            )
            vectors = aggregate["vectors"]
            if vectors:
                dimensions = len(vectors[0])
                query_embeddings.append([
                    sum(vector[dimension] for vector in vectors) / len(vectors)
                    for dimension in range(dimensions)
                ])
                query_node_ids.append(node_id)

        vectors_by_id = dict(zip(query_node_ids, query_embeddings))
        proposals = _build_composite_proposals(
            nodes_by_id, vectors_by_id, min_similarity, neighbors
        )

        # Keep every threshold-qualified Top-K proposal. Requiring mutual KNN
        # made sparse or heterogeneous corpora return nodes with zero visible
        # edges even though Chroma had valid semantic neighbours.
        edges = _proposal_edges(proposals, max_edges)
        for edge in edges:
            nodes_by_id[edge.source].degree += 1
            nodes_by_id[edge.target].degree += 1
        nodes = list(nodes_by_id.values())
        for node in nodes:
            node.size = min(24.0, 6.0 + node.degree * 1.35)

        isolated_count = sum(node.degree == 0 for node in nodes)
        stats = GraphStats(
            node_count=len(nodes),
            edge_count=len(edges),
            isolated_count=isolated_count,
            groups=group_counts,
            types=type_counts,
            tags=dict(sorted(tag_counts.items(), key=lambda item: item[1], reverse=True)[:50]),
        )
        logger.info(
            "ANN graph built: nodes=%d edges=%d isolated=%d threshold=%.2f k=%d",
            len(nodes), len(edges), isolated_count, min_similarity, neighbors,
        )
        response = GraphResponse(nodes=nodes, edges=edges, stats=stats)
        if len(_graph_cache) >= 16:
            oldest = min(_graph_cache, key=lambda key: _graph_cache[key][0])
            _graph_cache.pop(oldest, None)
        _graph_cache[cache_key] = (time.monotonic(), response)
        return response
    except Exception as exc:
        logger.exception("Unable to build semantic graph")
        raise HTTPException(status_code=503, detail="Semantic graph is temporarily unavailable") from exc
