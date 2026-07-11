"""Scalable semantic graph API backed by Chroma's ANN index."""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import get_current_user
from config import settings
from database import get_chroma_collection
from routers.documents import _pseudo_id

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


_KEYWORDS = {
    "商业": ("商业", "盈利", "收入", "市场", "投资", "融资", "客户", "变现", "business", "revenue"),
    "产品": ("产品", "功能", "用户", "交互", "界面", "设计", "需求", "product", "ux", "feature"),
    "运营": ("运营", "流量", "转化", "留存", "增长", "数据", "指标", "活动"),
    "营销": ("营销", "推广", "品牌", "广告", "文案", "投放", "seo", "marketing"),
    "思考": ("思考", "认知", "逻辑", "批判", "观点", "反思", "哲学", "critical"),
    "生活": ("生活", "日常", "旅行", "美食", "健身", "音乐", "电影", "life", "travel"),
    "技术": ("技术", "代码", "编程", "架构", "服务器", "算法", "code", "python", "api", "docker"),
    "学习": ("学习", "笔记", "教程", "阅读", "课程", "知识", "learn", "study", "book"),
    "创作": ("写作", "小说", "文字", "故事", "创作", "人物", "情节", "write", "story"),
}

_SOURCE_TYPES = {
    "notion": "Notion",
    "manual": "Manual note",
    "note": "Manual note",
    "file": "File",
    "pdf": "File",
    "web": "Web page",
    "url": "Web page",
    "telegram": "Imported",
    "flomo": "Imported",
    "chromadb": "Imported",
}


def normalized_source_type(source: str, metadata: dict) -> str:
    """Map importer-specific source labels into stable graph types."""
    explicit = str(metadata.get("source_type") or "").strip().lower()
    raw = explicit or source.strip().lower()
    for key, label in _SOURCE_TYPES.items():
        if key in raw:
            return label
    return "Unknown"


def normalized_tags(metadata: dict) -> list[str]:
    raw = metadata.get("tags") or metadata.get("tag") or []
    if isinstance(raw, str):
        raw = [part.strip() for part in raw.replace("，", ",").split(",")]
    if not isinstance(raw, list):
        return []
    return list(dict.fromkeys(str(tag).strip()[:40] for tag in raw if str(tag).strip()))[:12]


def dominant_group(text: str, title: str, metadata: dict) -> str:
    """Prefer explicit metadata and fall back to deterministic keywords."""
    explicit = metadata.get("group") or metadata.get("category")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()[:32]
    combined = f"{title} {(text or '')[:500]}".lower()
    scores = {group: sum(keyword in combined for keyword in words) for group, words in _KEYWORDS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] else "随笔"


def content_snippet(text: str, max_len: int = 110) -> str:
    compact = " ".join((text or "").split())
    if len(compact) <= max_len:
        return compact
    for separator in ("。", ". ", "，", ", ", " "):
        index = compact[:max_len].rfind(separator)
        if index >= max_len // 2:
            return compact[: index + (1 if separator in {"。", "，"} else 0)] + "…"
    return compact[:max_len] + "…"


def display_label(title: str, max_len: int = 80) -> str:
    """Keep enough title for search/tooltips; the Canvas controls rendering."""
    compact = " ".join(title.split())
    return compact if len(compact) <= max_len else compact[:max_len] + "…"


def _empty_response() -> GraphResponse:
    return GraphResponse(
        nodes=[],
        edges=[],
        stats=GraphStats(node_count=0, edge_count=0, isolated_count=0, groups={}),
    )


def _node_identity(chroma_id: str, metadata: dict) -> tuple[str, int]:
    """Collapse all chunks belonging to one document into one graph node."""
    raw_document_id = metadata.get("document_id")
    try:
        document_id = int(raw_document_id)
        return f"document:{document_id}", document_id
    except (TypeError, ValueError):
        return f"chroma:{chroma_id}", _pseudo_id(chroma_id)


@router.get("/full", response_model=GraphResponse)
async def get_full_graph(
    limit: int = Query(default=settings.graph_default_limit, ge=10, le=500),
    min_similarity: float = Query(default=0.45, ge=0.05, le=0.95),
    neighbors: int = Query(default=settings.graph_neighbors_per_node, ge=2, le=50),
    max_edges: int = Query(default=settings.graph_max_edges, ge=10, le=5000),
    _user: str = Depends(get_current_user),
):
    """Return an ANN Top-K semantic graph.

    Chroma's HNSW index finds a small neighbor set for each node.  This avoids
    the previous O(n²) Python cosine loop and bounds graph density explicitly.
    """
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
            node_id, document_id = _node_identity(chroma_id, metadata)
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

        proposals: dict[tuple[str, str], dict[str, object]] = {}
        if query_embeddings:
            nearest = collection.query(
                query_embeddings=query_embeddings,
                # Oversample because the nearest records may be sibling chunks
                # from the same document and are collapsed below.
                n_results=min(neighbors * 8 + 1, collection.count()),
                include=["distances", "metadatas"],
            )
            neighbor_ids = nearest.get("ids") or []
            neighbor_distances = nearest.get("distances") or []
            neighbor_metadatas = nearest.get("metadatas") or []
            allowed = set(nodes_by_id)
            for source_index, source_id in enumerate(query_node_ids):
                if source_index >= len(neighbor_ids):
                    continue
                distances = neighbor_distances[source_index] if source_index < len(neighbor_distances) else []
                metadata_row = neighbor_metadatas[source_index] if source_index < len(neighbor_metadatas) else []
                accepted = 0
                for target_index, target_chroma_id in enumerate(neighbor_ids[source_index]):
                    target_metadata = metadata_row[target_index] if target_index < len(metadata_row) else {}
                    target_id, _ = _node_identity(target_chroma_id, target_metadata or {})
                    if target_id == source_id or target_id not in allowed or target_index >= len(distances):
                        continue
                    similarity = max(0.0, min(1.0, 1.0 - float(distances[target_index])))
                    if similarity < min_similarity:
                        continue
                    pair = tuple(sorted((source_id, target_id)))
                    proposal = proposals.setdefault(pair, {"weight": 0.0, "directions": set()})
                    proposal["weight"] = max(float(proposal["weight"]), similarity)
                    directions = proposal["directions"]
                    if isinstance(directions, set):
                        directions.add(source_id)
                    accepted += 1
                    if accepted >= neighbors:
                        break

        # Mutual KNN removes one-sided/noisy similarities. Very strong edges
        # survive even when only one endpoint selected the other.
        edges = [
            GraphEdge(
                source=pair[0], target=pair[1], weight=round(float(value["weight"]), 4),
                label=f"semantic {float(value['weight']):.2f}",
            )
            for pair, value in proposals.items()
            if len(value["directions"]) >= 2 or float(value["weight"]) >= min(0.95, min_similarity + 0.12)
        ]
        edges = sorted(edges, key=lambda edge: edge.weight, reverse=True)[:max_edges]
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
