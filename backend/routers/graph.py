"""Graph router — semantic knowledge network via vector similarity."""

from __future__ import annotations

import logging
import math

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from auth import get_current_user
from database import get_chroma_collection

logger = logging.getLogger("knowledge-atlas.graph")
router = APIRouter(prefix="/api/graph", tags=["graph"])


class GraphNode(BaseModel):
    id: str
    label: str
    group: str
    size: int = 10
    # Content preview for tooltip
    snippet: str = ""


class GraphEdge(BaseModel):
    source: str
    target: str
    weight: float = 1.0
    label: str = ""


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


# ── NLP stopwords ──────────────────────────────────────────────────

_COMMON = {
    "the", "is", "at", "which", "on", "a", "an", "and", "or", "of",
    "to", "in", "for", "with", "it", "that", "this", "be", "are",
    "的", "是", "了", "在", "和", "也", "就", "都", "不", "有",
    "我", "你", "他", "她", "它", "们", "这", "那", "什么", "怎么",
    "一个", "可以", "没有", "他们", "我们", "这个", "如果", "因为",
    "所以", "但是", "而且", "或者", "已经", "还是", "就是", "不是",
    "还", "要", "会", "能", "很", "与", "让", "从", "把", "被",
    "吗", "呢", "吧", "啊", "哦", "嗯", "之", "其", "些", "各",
}

_GROUPS = ["商业", "产品", "运营", "营销", "思考", "生活", "技术", "学习", "创作", "随笔"]


def _dominant_group(text: str, title: str) -> str:
    """Assign a semantic group based on keyword presence in text."""
    combined = (title + " " + (text or "")[:300]).lower()
    signals: dict[str, int] = {}

    kw_map = {
        "商业": ["商业", "盈利", "收入", "市场", "投资", "融资", "客户", "变现", "business", "revenue", "profit"],
        "产品": ["产品", "功能", "用户", "交互", "界面", "设计", "需求", "product", "ux", "feature"],
        "运营": ["运营", "流量", "转化", "留存", "增长", "数据", "指标", "活动"],
        "营销": ["营销", "推广", "品牌", "广告", "文案", "投放", "seo", "marketing", "brand"],
        "思考": ["思考", "认知", "逻辑", "批判", "观点", "反思", "哲学", "think", "critical"],
        "生活": ["生活", "日常", "旅行", "美食", "健身", "音乐", "电影", "life", "travel"],
        "技术": ["技术", "代码", "编程", "架构", "服务器", "算法", "code", "python", "api", "docker"],
        "学习": ["学习", "笔记", "教程", "阅读", "课程", "知识", "learn", "study", "book"],
        "创作": ["写作", "小说", "文字", "故事", "创作", "人物", "情节", "write", "story", "novel"],
        "随笔": ["随笔", "感想", "记录", "碎片", "日记", "杂", "journal", "note"],
    }

    for group, kws in kw_map.items():
        signals[group] = sum(1 for kw in kws if kw in combined)

    if not signals or max(signals.values()) == 0:
        return "随笔"
    return max(signals, key=lambda g: signals[g])


def _content_snippet(text: str, max_len: int = 80) -> str:
    """Extract first meaningful sentence for tooltip."""
    if not text:
        return ""
    t = text.strip().replace("\n", " ")
    if len(t) <= max_len:
        return t
    # Try to break at sentence boundary
    for sep in ["。", "，", ". ", ", ", " "]:
        idx = t[:max_len].rfind(sep)
        if idx > max_len * 0.5:
            return t[:idx] + "…"
    return t[:max_len] + "…"


# ── Cosine similarity helpers ──────────────────────────────────────


def _cosine_sim(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


# ── Endpoints ──────────────────────────────────────────────────────


@router.get("/full", response_model=GraphResponse)
async def get_full_graph(
    limit: int = Query(default=120, ge=10, le=500),
    min_similarity: float = Query(default=0.25, ge=0.1, le=0.9),
    _user: str = Depends(get_current_user),
):
    """Build knowledge graph from ChromaDB using vector similarity.

    Edges represent *semantic relevance* between documents — two notes
    are connected when their embedding vectors are close in high-dimensional
    space, meaning they discuss overlapping concepts.
    """
    try:
        collection = get_chroma_collection()
        # Fetch documents WITH embeddings — this is key for semantic edges
        result = collection.get(
            limit=min(limit, 500),
            include=["documents", "metadatas", "embeddings"],
        )

        if not result["ids"]:
            return GraphResponse(nodes=[], edges=[])

        n = len(result["ids"])

        # ── Build nodes ──────────────────────────────────────────
        nodes: list[GraphNode] = []
        node_ids: list[str] = []

        for i in range(n):
            cid = result["ids"][i]
            meta = (result["metadatas"][i] or {}) if result["metadatas"] else {}
            text = (result["documents"][i] or "") if result["documents"] else ""
            title = meta.get("title", f"Note {i + 1}")

            group = _dominant_group(text, title)
            snippet = _content_snippet(text)

            node_id = f"n{i}"
            nodes.append(GraphNode(
                id=node_id,
                label=title[:40],
                group=group,
                size=min(8 + len(text) // 500, 25),
                snippet=snippet,
            ))
            node_ids.append(node_id)

        # ── Build edges via vector similarity ────────────────────
        embeddings: list[list[float]] = []
        if result["embeddings"] is not None and len(result["embeddings"]) == n:
            for emb in result["embeddings"]:
                if emb is not None and len(emb) > 0:
                    # ChromaDB may return numpy arrays — convert to list
                    embeddings.append(emb.tolist() if hasattr(emb, "tolist") else list(emb))
                else:
                    embeddings.append([])

        edges: list[GraphEdge] = []

        if embeddings and len(embeddings) == n:
            for i in range(n):
                for j in range(i + 1, n):
                    sim = _cosine_sim(embeddings[i], embeddings[j])
                    if sim >= min_similarity:
                        edges.append(GraphEdge(
                            source=node_ids[i],
                            target=node_ids[j],
                            weight=round(sim, 3),
                            label=f"semantic {sim:.2f}",
                        ))

        # Sort by weight descending, keep top 1500
        edges.sort(key=lambda e: e.weight, reverse=True)
        edges = edges[:1500]

        # ── Stats ────────────────────────────────────────────────
        logger.info(
            "Graph built: %d nodes, %d edges (sim≥%.2f) — density %.1f%%",
            len(nodes),
            len(edges),
            min_similarity,
            (len(edges) / (len(nodes) * (len(nodes) - 1) / 2) * 100) if len(nodes) > 1 else 0,
        )

        return GraphResponse(nodes=nodes, edges=edges)

    except Exception as e:
        logger.error(f"Graph error: {e}")
        return GraphResponse(nodes=[], edges=[])
