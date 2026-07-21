"""Agent / AI Q&A router — corpus-grounded personal AI with query-intent routing."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from config import settings
from database import get_chroma_collection
from models import AgentMemory
from schemas import (
    AgentMemoryStatusResponse, AgentStatusResponse, AskRequest, AskResponse, Citation,
    MemoryInsightResponse, MemoryLevelStatus, MemoryReviewRequest,
    TagSuggestRequest, TagSuggestResponse,
    WritingAssistRequest, WritingAssistResponse, WritingFlowStep, WritingIssue, WritingReference,
)
from services.search_service import SearchService, SearchResult
from services.memory_service import memory_automation, memory_is_stale
from utils import (
    _IDENTITY_FACETS,
    is_broad_identity_question,
    json_object_from_model,
    legacy_document_key,
    mmr_diversify,
    pseudo_id,
)

router = APIRouter(prefix="/api/agent", tags=["agent"])
logger = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────


def deepseek_error_message(exc: Exception) -> str:
    """Return an actionable, credential-safe provider error for the UI."""
    if isinstance(exc, AuthenticationError):
        return "DeepSeek rejected the API key (HTTP 401). Create a new key and rebuild the backend container."
    if isinstance(exc, NotFoundError):
        return "DeepSeek returned HTTP 404. Check DEEPSEEK_BASE_URL and DEEPSEEK_MODEL."
    if isinstance(exc, RateLimitError):
        return "DeepSeek rate limit or account balance limit reached (HTTP 429). Check the DeepSeek account."
    if isinstance(exc, APITimeoutError):
        return "The backend timed out while connecting to DeepSeek. Check server outbound HTTPS access."
    if isinstance(exc, APIConnectionError):
        return "The backend cannot connect to DeepSeek. Check DNS, firewall, proxy, and outbound HTTPS access from the backend container."
    if isinstance(exc, APIStatusError):
        return f"DeepSeek returned HTTP {exc.status_code}. Check the API configuration and DeepSeek account status."
    return "DeepSeek request failed unexpectedly. Check backend logs for the exception type."


async def save_memory(
    db: AsyncSession,
    session_id: str,
    level: str,
    role: str,
    content: str,
    metadata: dict | None = None,
) -> None:
    db.add(AgentMemory(
        session_id=session_id,
        level=level,
        role=role,
        content=content,
        metadata_=metadata or {},
    ))
    await db.flush()


def insight_response(memory: AgentMemory) -> MemoryInsightResponse:
    metadata = memory.metadata_ or {}
    state = str(metadata.get("memory_state") or "hypothesis")
    if state not in {"fact", "trend", "hypothesis"}:
        state = "hypothesis"
    evidence_ids: list[int] = []
    for value in metadata.get("evidence_document_ids", []):
        try:
            evidence_ids.append(int(value))
        except (TypeError, ValueError):
            continue
    return MemoryInsightResponse(
        id=str(memory.id),
        statement=memory.content,
        insight_type=str(metadata.get("insight_type") or "pattern"),
        confidence=float(metadata.get("confidence") or 0),
        status=str(metadata.get("status") or "pending"),
        memory_state=state,
        source=str(metadata.get("source") or "unknown"),
        trust_source=str(metadata.get("trust_source") or "auto_observed"),
        pinned=bool(metadata.get("pinned")),
        requires_review=bool(metadata.get("requires_review")),
        conflict_with=metadata.get("conflict_with"),
        occurrences=max(1, int(metadata.get("occurrences") or 1)),
        stale=memory_is_stale(metadata),
        evidence_document_ids=evidence_ids,
        first_seen=metadata.get("first_seen"),
        last_seen=metadata.get("last_seen"),
        created_at=memory.created_at,
    )


def select_response_strategy(question: str, broad_identity: bool = False) -> str:
    """Choose an internal response style without exposing mode switches in the UI."""
    lowered = question.casefold()
    socratic_markers = (
        "问我问题", "反问我", "挑战我的", "苏格拉底", "帮我做选择", "该不该",
        "是否应该", "challenge me", "ask me questions", "socratic", "trade-off",
    )
    reflection_markers = (
        "我是谁", "为什么我", "我的想法", "我的模式", "怎么看我", "了解自己",
        "反思", "变化", "矛盾", "反复出现", "who am i", "about me", "my pattern",
        "why do i", "reflect", "recurring", "becoming",
    )
    if any(marker in lowered for marker in socratic_markers):
        return "socratic"
    if broad_identity or any(marker in lowered for marker in reflection_markers):
        return "reflection"
    return "knowledge"


# ── Multi-facet retrieval ─────────────────────────────────────────


async def multi_facet_retrieval(
    search_service: SearchService,
    question: str,
    document_id: int | None,
    db: AsyncSession,
) -> list[SearchResult]:
    """Retrieve diverse evidence across identity facets for broad personal questions."""
    all_results: list[SearchResult] = []
    seen_ids: set[tuple[int, str | None]] = set()

    for facet_name, facet_query in _IDENTITY_FACETS:
        try:
            facet_results = await search_service.search(
                query=facet_query,
                search_type="vector",
                top_k=25,
                document_id=document_id,
                db=db,
            )
            for r in facet_results:
                key = (r.document_id, r.chunk_id)
                if key not in seen_ids:
                    seen_ids.add(key)
                    all_results.append(r)
        except Exception:
            logger.exception("Facet retrieval failed for %s", facet_name)

    # Also include direct question search
    try:
        direct_results = await search_service.search(
            query=question,
            search_type="vector",
            top_k=25,
            document_id=document_id,
            db=db,
        )
        for r in direct_results:
            key = (r.document_id, r.chunk_id)
            if key not in seen_ids:
                seen_ids.add(key)
                all_results.append(r)
    except Exception:
        logger.exception("Direct search failed")

    semantic_results = mmr_diversify(all_results, None, lambda_param=0.65, top_n=60)
    selected_keys = {(item.document_id, item.chunk_id) for item in semantic_results}

    # Semantic retrieval alone can miss older Chinese legacy vectors that were
    # embedded with an English-first model. Add a bounded, source-diverse corpus
    # sample for broad self-analysis so the model sees the breadth of the user's
    # notebook instead of whichever single chunk happens to rank first.
    for result in corpus_profile_sample(limit=80):
        key = (result.document_id, result.chunk_id)
        if key not in selected_keys:
            selected_keys.add(key)
            semantic_results.append(result)
        if len(semantic_results) >= 100:
            break

    return semantic_results


def corpus_profile_sample(limit: int = 24) -> list[SearchResult]:
    """Return a deterministic broad sample of the vector corpus.

    This is deliberately only used for profile/identity questions. It combines
    recent notes and source/title diversity without sending the entire corpus to
    the LLM. Canonical and legacy Chroma records receive stable document IDs.
    """
    try:
        result = get_chroma_collection().get(include=["documents", "metadatas"])
        rows: list[tuple[float, SearchResult]] = []
        ids = list(result.get("ids") or [])
        documents = list(result.get("documents") or [])
        metadatas = list(result.get("metadatas") or [])
        for index, chroma_id in enumerate(ids):
            metadata = (metadatas[index] or {}) if index < len(metadatas) else {}
            content = (documents[index] or "") if index < len(documents) else ""
            if not content.strip():
                continue
            raw_id = metadata.get("document_id")
            try:
                document_id = int(raw_id)
            except (TypeError, ValueError):
                document_id = 0
            if not document_id:
                document_id = pseudo_id(legacy_document_key(chroma_id, metadata, content))
            raw_date = metadata.get("updated_at") or metadata.get("created_at") or metadata.get("timestamp")
            timestamp = 0.0
            if raw_date:
                try:
                    timestamp = datetime.fromisoformat(str(raw_date).replace("Z", "+00:00")).timestamp()
                except (TypeError, ValueError):
                    pass
            rows.append((timestamp, SearchResult(
                title=str(metadata.get("title") or "Untitled"),
                snippet=content[:900],
                source=str(metadata.get("source") or "chromadb"),
                source_type=str(metadata.get("source") or "chromadb"),
                similarity_score=0.35,
                document_id=document_id,
                chunk_id=chroma_id,
                url=metadata.get("url") or metadata.get("notion_page_id"),
            )))

        rows.sort(key=lambda item: item[0], reverse=True)
        chosen: list[SearchResult] = []
        seen_documents: set[int] = set()
        seen_titles: set[str] = set()
        # Recent half first, then evenly walk the corpus to represent older ideas.
        recent_quota = max(1, limit // 2)
        candidates = rows[:recent_quota]
        if rows:
            stride = max(1, len(rows) // max(1, limit - recent_quota))
            candidates += rows[::stride]
        for _, item in candidates:
            title_key = item.title.strip().lower()
            if item.document_id in seen_documents or title_key in seen_titles:
                continue
            seen_documents.add(item.document_id)
            seen_titles.add(title_key)
            chosen.append(item)
            if len(chosen) >= limit:
                break
        return chosen
    except Exception:
        logger.exception("Unable to build broad corpus profile sample")
        return []


# ── Memory insights ───────────────────────────────────────────────


@router.get("/memory/insights", response_model=list[MemoryInsightResponse])
async def memory_insights(
    status: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    await memory_automation.upgrade_legacy_memories(db)
    query = select(AgentMemory).where(AgentMemory.level == "L3").order_by(AgentMemory.created_at.desc()).limit(300)
    memories = (await db.execute(query)).scalars().all()
    results = [insight_response(memory) for memory in memories]
    if status:
        return [item for item in results if item.status == status]
    return [item for item in results if item.status != "rejected"]


@router.post("/memory/insights/{memory_id}/review", response_model=MemoryInsightResponse)
async def review_memory_insight(
    memory_id: str,
    body: MemoryReviewRequest,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    memory = await db.get(AgentMemory, memory_id)
    if not memory or memory.level != "L3":
        raise HTTPException(status_code=404, detail="Memory insight not found")
    action = body.action
    if not action and body.status:
        action = "confirm" if body.status == "confirmed" else "reject"
    if not action:
        raise HTTPException(status_code=422, detail="A memory action is required")

    metadata = dict(memory.metadata_ or {})
    now = datetime.now().astimezone().isoformat()
    if action in {"confirm", "pin"}:
        metadata.update({
            "status": "confirmed",
            "pinned": action == "pin" or bool(metadata.get("pinned")),
            "requires_review": False,
            "trust_source": "user_pinned" if action == "pin" else "user_confirmed",
            "last_seen": now,
        })
    elif action in {"reject", "forget"}:
        metadata.update({
            "status": "rejected",
            "pinned": False,
            "requires_review": False,
            "forgotten_at": now,
            "trust_source": "user_forgotten",
        })
    elif action == "correct":
        if not body.statement or not body.statement.strip():
            raise HTTPException(status_code=422, detail="Corrected memory text is required")
        memory.content = body.statement.strip()
        metadata.update({
            "status": "confirmed",
            "memory_state": "fact",
            "confidence": 1.0,
            "pinned": True,
            "requires_review": False,
            "trust_source": "user_corrected",
            "last_seen": now,
        })
    memory.metadata_ = metadata
    await db.flush()
    return insight_response(memory)


# ── Status endpoints ──────────────────────────────────────────────


@router.get("/memory/status", response_model=AgentMemoryStatusResponse)
async def memory_status(
    session_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    query = select(AgentMemory.level, func.count(AgentMemory.id)).group_by(AgentMemory.level)
    if session_id:
        query = query.where(AgentMemory.session_id == session_id)
    counts = dict((await db.execute(query)).all())
    try:
        vector_count = get_chroma_collection().count()
    except Exception:
        vector_count = 0
    return AgentMemoryStatusResponse(
        session_id=session_id,
        vector_count=vector_count,
        levels=[
            MemoryLevelStatus(level="L0", title="Conversation", count=counts.get("L0", 0), description="Raw user and assistant turns stored for session continuity."),
            MemoryLevelStatus(level="L1", title="Vector knowledge", count=vector_count, description="Persistent Chroma chunks available for semantic retrieval."),
            MemoryLevelStatus(level="L2", title="Retrieved context", count=counts.get("L2", 0), description="Knowledge snapshots actually retrieved and used in answers."),
            MemoryLevelStatus(level="L3", title="Automatic memory", count=counts.get("L3", 0), description="Direct facts, recurring trends, and inspectable hypotheses learned from your writing."),
        ],
    )


@router.get("/status", response_model=AgentStatusResponse)
async def agent_status(_user: str = Depends(get_current_user)):
    """Expose readiness without exposing credentials or provider responses."""
    try:
        vector_count = get_chroma_collection().count()
    except Exception:
        logger.exception("Unable to inspect ChromaDB for agent readiness")
        vector_count = 0
    deepseek_available = False
    deepseek_error = None
    if settings.deepseek_api_key:
        client = AsyncOpenAI(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
            timeout=min(settings.deepseek_timeout_seconds, 10),
            max_retries=0,
        )
        try:
            await client.chat.completions.create(
                model=settings.deepseek_model,
                messages=[{"role": "user", "content": "ping"}],
                temperature=0,
                max_tokens=1,
            )
            deepseek_available = True
        except Exception as exc:
            logger.warning("DeepSeek readiness probe failed: %s", exc)
            deepseek_error = deepseek_error_message(exc)
    return AgentStatusResponse(
        deepseek_configured=bool(settings.deepseek_api_key),
        deepseek_available=deepseek_available,
        deepseek_error=deepseek_error,
        vector_store_available=vector_count > 0,
        vector_document_count=vector_count,
        model=settings.deepseek_model,
    )


# ── Main Q&A endpoint ─────────────────────────────────────────────


@router.post("/suggest-tags", response_model=TagSuggestResponse)
async def suggest_tags(
    body: TagSuggestRequest,
    _user: str = Depends(get_current_user),
):
    """Suggest a small set of reusable topic tags for an untagged note."""
    if not settings.deepseek_api_key:
        raise HTTPException(status_code=503, detail="DeepSeek is not configured for tag suggestions.")
    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=settings.deepseek_timeout_seconds,
        max_retries=2,
    )
    try:
        response = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Return valid JSON with one key, tags. Suggest 2 to 5 concise, reusable topic tags. "
                        "Prefer concepts over formats, merge synonyms, use the note's language, and never include #."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Title: {body.title or '(untitled)'}\n\nNote:\n{body.content[:30_000]}",
                },
            ],
            temperature=0.1,
            max_tokens=220,
        )
    except Exception as exc:
        logger.exception("Tag suggestion request failed")
        raise HTTPException(status_code=502, detail=deepseek_error_message(exc)) from exc
    payload = json_object_from_model(response.choices[0].message.content or "")
    values = payload.get("tags") or []
    if not isinstance(values, list):
        values = []
    tags = list(dict.fromkeys(
        str(value).strip().lstrip("#")[:40]
        for value in values
        if str(value).strip().lstrip("#")
    ))[:5]
    return TagSuggestResponse(tags=tags)


@router.post("/writing-assist", response_model=WritingAssistResponse)
async def writing_assist(
    body: WritingAssistRequest,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Review a draft using DeepSeek and knowledge-base references."""
    draft = body.content[:30_000]
    structural_query = "\n".join(filter(None, (
        body.title,
        draft[:1200],
        draft[max(0, len(draft) // 2 - 600):len(draft) // 2 + 600],
        draft[-1200:],
    )))
    search_results = await SearchService().search(
        query=structural_query,
        search_type="hybrid",
        top_k=20,
        db=db,
    )
    references: list[WritingReference] = []
    seen_documents: set[int] = set()
    for result in search_results:
        if result.document_id == body.document_id or result.document_id in seen_documents:
            continue
        seen_documents.add(result.document_id)
        references.append(WritingReference(
            document_id=result.document_id,
            title=result.title,
            connection=result.snippet[:240],
            relevance=round(result.similarity_score, 3),
        ))
        if len(references) >= 5:
            break

    if not settings.deepseek_api_key:
        raise HTTPException(status_code=503, detail="DeepSeek is not configured for writing assistance.")

    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=settings.deepseek_timeout_seconds,
        max_retries=2,
    )
    history_context = "\n\n".join(
        f"Reference {index + 1}: {reference.title}\n{reference.connection}"
        for index, reference in enumerate(references)
    ) or "No sufficiently relevant historical notes were found."
    try:
        response = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a private writing coach grounded in the user's knowledge base. "
                        "Review only the supplied draft and references; never invent facts. Return valid JSON with keys "
                        "suggested_titles (max 4 strings), directions (max 4 strings), logic_flow "
                        "(max 8 objects in the draft's actual argument order; keys: label, summary, relation, "
                        "strength where strength is clear, weak, or missing), logic_issues and grammar_issues "
                        "(max 6 objects each; keys: excerpt, issue, suggestion). The logic flow must show how "
                        "the opening, claims, evidence, transitions, and conclusion connect; mark missing links. Be concise, "
                        "specific, constructive, and use the draft's language. Do not call stylistic preference a grammar error."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Current title: {body.title or '(untitled)'}\n\nDraft:\n{draft}\n\n"
                        f"Relevant historical notes (reference only):\n{history_context}"
                    ),
                },
            ],
            temperature=0.2,
            max_tokens=1800,
        )
    except Exception as exc:
        logger.exception("Writing assistance request failed")
        raise HTTPException(status_code=502, detail=deepseek_error_message(exc)) from exc

    payload = json_object_from_model(response.choices[0].message.content or "")

    def strings(key: str, limit: int) -> list[str]:
        values = payload.get(key) or []
        if not isinstance(values, list):
            return []
        return [str(value).strip()[:500] for value in values if str(value).strip()][:limit]

    def issues(key: str) -> list[WritingIssue]:
        values = payload.get(key) or []
        if not isinstance(values, list):
            return []
        parsed: list[WritingIssue] = []
        for value in values[:6]:
            if not isinstance(value, dict) or not str(value.get("issue") or "").strip():
                continue
            parsed.append(WritingIssue(
                excerpt=str(value.get("excerpt") or "")[:300],
                issue=str(value.get("issue") or "")[:500],
                suggestion=str(value.get("suggestion") or "")[:700],
            ))
        return parsed

    def flow_steps() -> list[WritingFlowStep]:
        values = payload.get("logic_flow") or []
        if not isinstance(values, list):
            return []
        parsed: list[WritingFlowStep] = []
        for value in values[:8]:
            if not isinstance(value, dict):
                continue
            label = str(value.get("label") or "").strip()
            summary = str(value.get("summary") or "").strip()
            if not label or not summary:
                continue
            strength = str(value.get("strength") or "clear").strip().lower()
            if strength not in {"clear", "weak", "missing"}:
                strength = "clear"
            parsed.append(WritingFlowStep(
                label=label[:100],
                summary=summary[:500],
                relation=str(value.get("relation") or "")[:200],
                strength=strength,
            ))
        return parsed

    return WritingAssistResponse(
        suggested_titles=strings("suggested_titles", 4),
        directions=strings("directions", 4),
        logic_flow=flow_steps(),
        logic_issues=issues("logic_issues"),
        grammar_issues=issues("grammar_issues"),
        historical_references=references,
    )


@router.post("/ask", response_model=AskResponse)
async def ask_question(
    body: AskRequest,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Corpus-grounded Q&A with query-intent routing for personal questions.

    - Identity/profile questions trigger multi-facet diverse retrieval.
    - Normal questions use focused vector search.
    - Every claim must be traceable to citations.
    """
    search_service = SearchService()
    session_id = body.session_id or uuid.uuid4().hex

    # Recent conversation history
    history_result = await db.execute(
        select(AgentMemory)
        .where(AgentMemory.session_id == session_id, AgentMemory.level == "L0")
        .order_by(AgentMemory.created_at.desc())
        .limit(8)
    )
    recent_history = list(reversed(history_result.scalars().all()))
    recent_user_context = [memory.content for memory in recent_history if memory.role == "user"][-3:]
    retrieval_query = "\n".join([*recent_user_context, body.question])

    # Trusted facts steer the answer directly. Strong recurring patterns may
    # help, but are explicitly labeled as tentative so inference never silently
    # becomes biography.
    confirmed_insights, emerging_insights = await memory_automation.context_memories(db)

    await save_memory(db, session_id, "L0", "user", body.question)
    memory_automation.schedule_conversation(
        session_id,
        body.question,
        [],
    )

    # Step 1: Retrieve relevant chunks — with intent routing
    broad_identity = is_broad_identity_question(body.question)

    if broad_identity and body.document_id is None:
        # Multi-facet retrieval for broad personal questions
        search_results = await multi_facet_retrieval(
            search_service, body.question, body.document_id, db
        )
        # Use larger pool
        search_results = search_results[:100]
    elif body.document_id is not None:
        # Document-scoped: focused retrieval
        search_results = await search_service.search(
            query=retrieval_query,
            search_type="vector",
            top_k=min(max(body.top_k, 100), 100),
            document_id=body.document_id,
            db=db,
        )
    else:
        # Normal: focused vector search with larger pool
        search_results = await search_service.search(
            query=retrieval_query,
            search_type="hybrid",
            top_k=min(max(body.top_k, 100), 100),
            document_id=body.document_id,
            db=db,
        )

    if not search_results:
        answer = "I couldn't find any relevant information in your knowledge base to answer this question. Try adding more notes first."
        await save_memory(db, session_id, "L0", "assistant", answer)
        return AskResponse(
            question=body.question,
            answer=answer,
            citations=[],
            session_id=session_id,
        )

    # Step 2: Build context string with deduplication
    context_parts = []
    context_results: list[SearchResult] = []
    chunks_per_document: dict[int, int] = {}
    doc_index = 0
    context_chars = 0
    max_context_chars = 80_000
    for r in search_results:
        per_document_limit = 100 if body.document_id is not None else 3
        if chunks_per_document.get(r.document_id, 0) >= per_document_limit:
            continue
        chunks_per_document[r.document_id] = chunks_per_document.get(r.document_id, 0) + 1
        next_index = doc_index + 1
        context_title = r.title[:140]
        context_snippet = r.snippet[:360]
        context_entry = (
            f"[Doc {next_index}] Title: {context_title}\n"
            f"Source: {r.source}\n"
            f"Content: {context_snippet}\n"
        )
        # Preserve room for system instructions, conversation history and the
        # generated answer while allowing up to 100 relevant notes.
        if context_results and context_chars + len(context_entry) > max_context_chars:
            break
        doc_index = next_index
        context_results.append(r)
        context_parts.append(context_entry)
        context_chars += len(context_entry)
        if doc_index >= 100:
            break

    context = "\n---\n".join(context_parts)
    await save_memory(
        db,
        session_id,
        "L2",
        "retrieval",
        context[:max_context_chars],
        {"document_ids": [r.document_id for r in context_results], "query": body.question},
    )

    # Step 3: Call DeepSeek
    if not settings.deepseek_api_key:
        answer = (
            "AI synthesis is unavailable (DeepSeek API key not configured). "
            "Here are the most relevant documents from your knowledge base:\n\n"
            + "\n".join(f"- **{r.title}**: {r.snippet[:200]}..." for r in search_results[:10])
        )
        await save_memory(db, session_id, "L0", "assistant", answer)
        return AskResponse(
            question=body.question,
            answer=answer,
            citations=[
                Citation(
                    document_id=r.document_id,
                    document_title=r.title,
                    chunk_snippet=r.snippet,
                    source_url=r.url,
                    similarity_score=r.similarity_score,
                )
                for r in search_results[:100]
            ],
            session_id=session_id,
        )

    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=settings.deepseek_timeout_seconds,
        max_retries=2,
    )

    broad_identity_preamble = ""
    if broad_identity:
        broad_identity_preamble = (
            "The user has asked a broad personal question about their identity, values, goals, "
            "or self-understanding. The retrieved context spans multiple facets of their note corpus. "
            "Synthesize a comprehensive but honest answer. "
            "Clearly distinguish what the notes explicitly say from what you infer. "
            "If the corpus lacks evidence on certain aspects, acknowledge the gaps. "
            "Never fabricate biography, personality, or mental-health claims. "
        )

    system_prompt = (
        "You are the user's AI assistant for their personal Notion knowledge base — "
        "like Notion AI, but private and self-hosted. You have full access to their "
        "curated notes spanning 8 domains (商业与电商/史政经/英语与语言/AI与技术/心理与成长"
        "/工作与职业/健康/生活) with detailed topic tags.\n\n"
        "Your capabilities:\n"
        "- Answer questions by searching across the entire note corpus\n"
        "- Summarize individual notes or groups of related notes\n"
        "- Find connections and patterns across different notes\n"
        "- Help organize, classify, and retrieve information\n"
        "- Assist with writing, research, and thinking\n\n"
        "How to respond:\n"
        "- Every substantive claim must cite specific notes as [Doc N]\n"
        "- Clearly distinguish what the user explicitly wrote from your inference\n"
        "- If evidence is insufficient, acknowledge the gap honestly — don't fabricate\n"
        "- Reply in the same language as the user\n"
        "- Treat notes as the user's writing and collected knowledge — some are personal "
        "reflections, some are research collections, not all are biography\n"
        "- Be concise, specific, and genuinely helpful — no generic AI platitudes\n"
        "- Adapt your style naturally: direct answers for factual questions, "
        "reflective synthesis for personal questions, draw connections when patterns emerge\n"
        + broad_identity_preamble
    )

    try:
        history_messages = [
            {"role": memory.role, "content": memory.content}
            for memory in recent_history
            if memory.role in {"user", "assistant"}
        ]
        response = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {"role": "system", "content": system_prompt},
                *history_messages,
                {
                    "role": "user",
                    "content": f"Trusted long-term memories (direct user statements or user-pinned):\n"
                    + ("\n".join(f"- {memory.content}" for memory in confirmed_insights) or "- None yet")
                    + "\n\nEmerging recurring patterns (tentative; mention only as inference):\n"
                    + ("\n".join(f"- {memory.content}" for memory in emerging_insights) or "- None yet")
                    + f"\n\nContext retrieved from your knowledge base:\n\n{context}\n\n"
                    f"Question: {body.question}\n\n"
                    f"Please answer based on the context above. Include citations "
                    f"referring to document numbers (e.g., [Doc 1], [Doc 2]).",
                },
            ],
            temperature=0.3,
            max_tokens=3000,
        )
        answer = response.choices[0].message.content or ""
        await save_memory(db, session_id, "L0", "assistant", answer)
    except Exception as exc:
        logger.exception("DeepSeek request failed; verify DeepSeek server configuration")
        diagnostic = deepseek_error_message(exc)
        answer = (
            f"DeepSeek is temporarily unavailable: {diagnostic}\n\n"
            "Your vector database is working. These are the most relevant notes:\n\n"
            + "\n".join(f"- **{r.title}**: {r.snippet[:240]}..." for r in search_results[:10])
        )
        await save_memory(db, session_id, "L0", "assistant", answer)
        return AskResponse(
            question=body.question,
            answer=answer,
            citations=[
                Citation(
                    document_id=r.document_id,
                    document_title=r.title,
                    chunk_snippet=r.snippet,
                    source_url=r.url,
                    similarity_score=r.similarity_score,
                )
                for r in search_results[:10]
            ],
            session_id=session_id,
        )

    # Step 4: Build citations
    citations = [
        Citation(
            document_id=r.document_id,
            document_title=r.title,
            chunk_snippet=r.snippet,
            source_url=r.url,
            similarity_score=r.similarity_score,
        )
        for r in context_results[:100]
    ]

    return AskResponse(
        question=body.question,
        answer=answer,
        citations=citations,
        session_id=session_id,
    )


# ── Corpus-driven insight extraction ──────────────────────────────


async def build_identity_profile(
    client: AsyncOpenAI,
    db: AsyncSession,
) -> dict:
    """Refresh the automatic profile without promoting model guesses to facts."""
    try:
        return await memory_automation.analyze_full_corpus(client, db)
    except Exception:
        logger.exception("Corpus identity profile extraction failed")
        return {"status": "error"}


@router.post("/memory/build-profile", response_model=dict)
async def build_identity_profile_endpoint(
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Trigger a full identity profile build from the note corpus."""
    if not settings.deepseek_api_key:
        return {"status": "skipped", "reason": "DeepSeek not configured"}

    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=settings.deepseek_timeout_seconds,
        max_retries=2,
    )
    result = await build_identity_profile(client, db)
    return result


@router.post("/memory/extract-from-corpus", response_model=dict)
async def extract_insights_from_corpus_endpoint(
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """Trigger insight extraction from recent note corpus. Idempotent."""
    if not settings.deepseek_api_key:
        return {"status": "skipped", "reason": "DeepSeek not configured"}

    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=settings.deepseek_timeout_seconds,
        max_retries=2,
    )
    return await memory_automation.analyze_full_corpus(client, db)
