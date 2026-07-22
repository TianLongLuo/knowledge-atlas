"""Scalable semantic graph API backed by Chroma's ANN index."""

from __future__ import annotations

import hashlib
import logging
import math
import re
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from config import settings
from database import get_chroma_collection, get_db
from models import Document
from utils import (
    canonical_document_key,
    pseudo_id as _pseudo_id,
    normalized_source_type,
    normalized_tags,
    dominant_group,
    content_snippet,
    document_display_title,
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


def _coerce_embedding(value: object) -> list[float] | None:
    """Accept Chroma list/NumPy output and reject malformed legacy rows."""
    if value is None:
        return None
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple)) or not value:
        return None
    try:
        vector = [float(item) for item in value]
    except (TypeError, ValueError):
        return None
    if not vector or not all(math.isfinite(item) for item in vector):
        return None
    return vector


def _average_compatible_vectors(vectors: list[list[float]]) -> list[float] | None:
    """Average only the dominant embedding dimension after a model migration."""
    if not vectors:
        return None
    dimension_counts: dict[int, int] = {}
    for vector in vectors:
        dimension_counts[len(vector)] = dimension_counts.get(len(vector), 0) + 1
    dimension = max(dimension_counts, key=dimension_counts.get)
    compatible = [vector for vector in vectors if len(vector) == dimension]
    if not compatible or dimension == 0:
        return None
    return [
        sum(vector[index] for vector in compatible) / len(compatible)
        for index in range(dimension)
    ]


def _lexical_vector(node: GraphNode, dimensions: int = 384) -> list[float]:
    """Create a stable local fallback for notes missing usable embeddings.

    Character n-grams keep this useful for Chinese text while word tokens cover
    English.  It is deliberately lightweight so a graph can still be rendered
    while a rebuilt vector collection is only partially populated.
    """
    combined = " ".join((node.label, node.snippet, node.group, *node.tags)).casefold()
    compact = re.sub(r"\s+", "", combined)
    features = re.findall(r"[a-z0-9][a-z0-9-]{1,}", combined)
    features.extend(
        compact[index:index + size]
        for size in (2, 3)
        for index in range(max(0, len(compact) - size + 1))
    )
    vector = [0.0] * dimensions
    for feature in features:
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[bucket] += sign
    return vector


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
    fallback_vectors_by_id: dict[str, list[float]] | None = None,
) -> dict[tuple[str, str], dict[str, object]]:
    normalized = {node_id: _normalized_vector(vector) for node_id, vector in vectors_by_id.items()}
    fallback_normalized = {
        node_id: _normalized_vector(vector)
        for node_id, vector in (fallback_vectors_by_id or {}).items()
    }
    candidates: dict[str, list[tuple[float, str, str]]] = {node_id: [] for node_id in nodes_by_id}
    node_ids = list(nodes_by_id)
    for source_index, source_id in enumerate(node_ids):
        for target_id in node_ids[source_index + 1:]:
            source_vector = normalized.get(source_id)
            target_vector = normalized.get(target_id)
            if source_vector and target_vector and len(source_vector) == len(target_vector):
                comparison_source, comparison_target = source_vector, target_vector
            else:
                comparison_source = fallback_normalized.get(source_id, [])
                comparison_target = fallback_normalized.get(target_id, [])
            semantic = max(0.0, min(1.0, sum(
                left * right for left, right in zip(comparison_source, comparison_target)
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
    db: AsyncSession = Depends(get_db),
):
    """Return a document graph blending semantic meaning, categories and tags."""
    cache_key = (limit, round(min_similarity, 3), neighbors, max_edges)
    cached = _graph_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < 30:
        return cached[1]
    try:
        # PostgreSQL is the canonical document store. Start there so a Chroma
        # metadata migration or partial vector rebuild can never hide the graph.
        aggregates: dict[str, dict] = {}
        sql_error: Exception | None = None
        try:
            sql_documents = (
                await db.execute(
                    select(Document).order_by(Document.updated_at.desc(), Document.id.desc()).limit(limit * 3)
                )
            ).scalars().all()
            seen_documents: set[tuple[str, str]] = set()
            for document in sql_documents:
                text = str(document.normalized_content or document.raw_content or "")
                content_key = canonical_document_key(str(document.title or ""), text)
                if content_key is None:
                    continue
                identity = ("content", content_key)
                if identity in seen_documents:
                    continue
                seen_documents.add(identity)
                metadata = dict(document.metadata_ or {}) if isinstance(document.metadata_, dict) else {}
                metadata.setdefault("source_type", str(document.source_type or "unknown"))
                aggregates[f"document:{document.id}"] = {
                    "document_id": int(document.id),
                    "title": str(document.title or ""),
                    "source": str(document.source_type or "unknown"),
                    "metadata": metadata,
                    "texts": [text] if text else [],
                    "vectors": [],
                }
                if len(aggregates) >= limit:
                    break
        except Exception as exc:
            sql_error = exc
            logger.warning("Canonical documents unavailable while building graph: %s", exc)

        # Merge any usable Chroma chunks and embeddings. All columns are read
        # defensively because old and rebuilt collections can temporarily have
        # different metadata shapes or incomplete rows.
        chroma_error: Exception | None = None
        try:
            collection = get_chroma_collection()
            result = collection.get(
                limit=min(limit * 8, 4000),
                include=["documents", "metadatas", "embeddings"],
            )
            raw_ids = result.get("ids")
            if hasattr(raw_ids, "tolist"):
                raw_ids = raw_ids.tolist()
            ids = list(raw_ids) if isinstance(raw_ids, (list, tuple)) else []
            raw_documents = result.get("documents")
            raw_metadatas = result.get("metadatas")
            raw_embeddings = result.get("embeddings")
            if hasattr(raw_documents, "tolist"):
                raw_documents = raw_documents.tolist()
            if hasattr(raw_metadatas, "tolist"):
                raw_metadatas = raw_metadatas.tolist()
            if hasattr(raw_embeddings, "tolist"):
                raw_embeddings = raw_embeddings.tolist()
            documents = list(raw_documents) if isinstance(raw_documents, (list, tuple)) else []
            metadatas = list(raw_metadatas) if isinstance(raw_metadatas, (list, tuple)) else []
            embeddings = list(raw_embeddings) if isinstance(raw_embeddings, (list, tuple)) else []

            for index, raw_chroma_id in enumerate(ids):
                chroma_id = str(raw_chroma_id)
                raw_metadata = metadatas[index] if index < len(metadatas) else {}
                metadata = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
                raw_text = documents[index] if index < len(documents) else ""
                text = str(raw_text or "")
                node_id, document_id = _node_identity(chroma_id, metadata, text)
                aggregate = aggregates.setdefault(node_id, {
                    "document_id": document_id,
                    "title": str(metadata.get("title") or ""),
                    "source": str(metadata.get("source") or "chromadb"),
                    "metadata": metadata,
                    "texts": [],
                    "vectors": [],
                })
                if len(aggregate["texts"]) < 4 and text and text not in aggregate["texts"]:
                    aggregate["texts"].append(text)
                vector = _coerce_embedding(embeddings[index] if index < len(embeddings) else None)
                if vector is not None:
                    aggregate["vectors"].append(vector)
                # Prefer canonical metadata, but fill any fields missing from a
                # partially migrated SQL record using the vector row.
                for key, value in metadata.items():
                    if value not in (None, "", [], {}) and not aggregate["metadata"].get(key):
                        aggregate["metadata"][key] = value
        except Exception as exc:
            chroma_error = exc
            logger.warning("Vector collection unavailable while building graph: %s", exc)

        if not aggregates:
            if sql_error and chroma_error:
                raise RuntimeError("Both canonical and vector knowledge stores are unavailable") from chroma_error
            return _empty_response()

        selected_aggregates = list(aggregates.items())[:limit]
        nodes_by_id: dict[str, GraphNode] = {}
        query_embeddings: list[list[float]] = []
        query_node_ids: list[str] = []
        fallback_vectors_by_id: dict[str, list[float]] = {}
        group_counts: dict[str, int] = {}
        type_counts: dict[str, int] = {}
        tag_counts: dict[str, int] = {}
        for node_id, aggregate in selected_aggregates:
            text = "\n".join(aggregate["texts"])
            title = document_display_title(aggregate["title"], text)
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
            averaged_vector = _average_compatible_vectors(vectors)
            if averaged_vector is not None:
                query_embeddings.append(averaged_vector)
                query_node_ids.append(node_id)
            fallback_vectors_by_id[node_id] = _lexical_vector(nodes_by_id[node_id])

        vectors_by_id = dict(zip(query_node_ids, query_embeddings))
        proposals = _build_composite_proposals(
            nodes_by_id,
            vectors_by_id,
            min_similarity,
            neighbors,
            fallback_vectors_by_id=fallback_vectors_by_id,
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
