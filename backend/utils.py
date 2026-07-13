"""Pure utility functions — no heavy dependencies."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from schemas import SearchResult


def json_object_from_model(raw: str) -> dict:
    """Parse a JSON object from plain or fenced model output."""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    try:
        value = json.loads(cleaned)
        return value if isinstance(value, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
        if not match:
            return {}
        try:
            value = json.loads(match.group(0))
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}


def pseudo_id(chroma_id: str) -> int:
    """Return a stable JavaScript-safe negative route ID for a Chroma record."""
    digest = hashlib.blake2b(chroma_id.encode(), digest_size=8).digest()
    return -(int.from_bytes(digest, "big") & ((1 << 52) - 1) or 1)


def normalize_document_id(raw: object) -> int:
    """Normalize document_id from Chroma metadata to int, handling string/int legacy."""
    if raw is None:
        return 0
    try:
        return int(raw)
    except (ValueError, TypeError):
        return 0


def normalized_text(value: str) -> str:
    """Normalize user text for deterministic duplicate detection."""
    return re.sub(r"\s+", " ", (value or "").strip()).casefold()


def content_fingerprint(title: str, content: str, source: str = "") -> str:
    """Fingerprint semantically identical imported records."""
    payload = "\n".join((normalized_text(source), normalized_text(title), normalized_text(content)))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def legacy_document_key(chroma_id: str, metadata: dict[str, Any], content: str = "") -> str:
    """Map legacy Chroma rows/chunks to one stable logical note identity."""
    stable_key = str(metadata.get("atlas_legacy_key") or "").strip()
    if stable_key:
        return stable_key

    raw_document_id = normalize_document_id(metadata.get("document_id"))
    if raw_document_id > 0:
        return f"document:{raw_document_id}"

    # Deterministic chunk writers conventionally suffix IDs this way.
    chunk_base = re.sub(r"(?:[_:-]chunk[_:-]?)\d+$", "", chroma_id, flags=re.IGNORECASE)
    if chunk_base != chroma_id:
        return f"chunk-family:{chunk_base}"

    source = str(metadata.get("source") or "chromadb")
    title = str(metadata.get("title") or "Untitled")
    external_identity = ""
    for field in ("source_id", "notion_page_id", "page_id", "external_id", "url"):
        value = str(metadata.get(field) or "").strip()
        if value:
            external_identity = f"external:{source.casefold()}:{field}:{value}"
            break

    # Chunked external documents must group by their parent identity.
    if metadata.get("chunk_index") is not None and external_identity:
        return external_identity

    timestamp = str(metadata.get("created_at") or metadata.get("timestamp") or "").strip()
    if metadata.get("chunk_index") is not None and timestamp:
        return f"import:{normalized_text(source)}:{normalized_text(title)}:{timestamp[:19]}"

    # Exact duplicate imports collapse even when importers assigned distinct
    # source IDs. This is the common cause of repeated Flomo rows.
    if content.strip():
        return f"content:{content_fingerprint(title, content, source)}"
    return external_identity or f"chroma:{chroma_id}"


def merge_chunk_texts(chunks: list[str]) -> str:
    """Join ordered chunks while removing repeated overlap and exact copies."""
    merged = ""
    seen: set[str] = set()
    for raw in chunks:
        text = (raw or "").strip()
        if not text:
            continue
        exact = normalized_text(text)
        if exact in seen:
            continue
        seen.add(exact)
        if not merged:
            merged = text
            continue
        max_overlap = min(len(merged), len(text), 240)
        overlap = 0
        for size in range(max_overlap, 7, -1):
            if merged[-size:] == text[:size]:
                overlap = size
                break
        merged = f"{merged}{text[overlap:]}" if overlap else f"{merged}\n\n{text}"
    return merged


# ── Query-intent routing ──────────────────────────────────────────

_IDENTITY_PATTERNS = re.compile(
    r"(?i)(who am i|who am I|what do i (believe|value|care about|stand for)|"
    r"what are my (goals|values|beliefs|priorities|principles)|"
    r"what am i (working (on|toward)|trying to|focused on)|"
    r"tell me about (myself|me)|describe (myself|my personality|my character)|"
    r"what kind of person am i|what defines me|"
    r"我是谁|我是什么样的人|我的价值观|我相信什么|我在追求什么|"
    r"我的目标|我的信仰|描述一下我|了解我自己|我关心什么|"
    r"我最近在做什么)"
)


def is_broad_identity_question(question: str) -> bool:
    """Detect broad personal/identity questions that need diverse retrieval."""
    return bool(_IDENTITY_PATTERNS.search(question))


_IDENTITY_FACETS = [
    ("identity", "我是谁？我的背景、职业、角色、自我描述是什么？ Who am I, my background and role?"),
    ("projects", "我目前在做什么项目、工作和行动？ What projects and work am I doing?"),
    ("goals", "我的目标、野心、愿望和长期方向是什么？ What are my goals and aspirations?"),
    ("values", "我重视、相信和关心什么？哪些原则指导我？ What do I value and believe?"),
    ("concerns", "我的笔记中反复出现哪些担忧、矛盾、困难和风险？ What concerns and tensions recur?"),
    ("decisions", "我做过或正在考虑哪些决定和改变？ What decisions and changes am I considering?"),
    ("relationships", "我如何看待他人、客户、合作伙伴和关系？ How do I think about people and relationships?"),
    ("recent", "我最近在关注什么？近期有什么变化和新想法？ What changed recently?"),
]


# ── MMR diversity ─────────────────────────────────────────────────


def mmr_diversify(
    results: list[SearchResult],
    query_embedding: list[float] | None,
    lambda_param: float = 0.7,
    top_n: int = 20,
) -> list[SearchResult]:
    """Maximal Marginal Relevance — select diverse results across documents/topics.

    lambda_param: weight on relevance (1.0 = pure relevance, 0.0 = pure diversity).
    """
    if not results or len(results) <= 1:
        return results

    if query_embedding is None:
        seen_docs = set()
        diverse = []
        for r in sorted(results, key=lambda x: x.similarity_score, reverse=True):
            if r.document_id not in seen_docs or len(seen_docs) >= len(results) // 2:
                diverse.append(r)
                seen_docs.add(r.document_id)
            if len(diverse) >= top_n:
                break
        return diverse

    selected = [results[0]]
    remaining = results[1:]

    while remaining and len(selected) < top_n:
        mmr_scores = []
        for candidate in remaining:
            relevance = candidate.similarity_score
            same_doc_penalty = sum(
                1.0 for s in selected if s.document_id == candidate.document_id
            ) / max(len(selected), 1)
            mmr = lambda_param * relevance - (1 - lambda_param) * same_doc_penalty
            mmr_scores.append((mmr, candidate))

        mmr_scores.sort(key=lambda x: x[0], reverse=True)
        best = mmr_scores[0][1]
        selected.append(best)
        remaining = [r for r in remaining if r.chunk_id != best.chunk_id]

    return selected


# ── Graph helpers ─────────────────────────────────────────────────

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
    compact = " ".join(title.split())
    return compact if len(compact) <= max_len else compact[:max_len] + "…"
