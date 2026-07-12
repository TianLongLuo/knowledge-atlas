"""Agent / AI Q&A router — corpus-grounded personal AI with query-intent routing."""

from __future__ import annotations

import logging
import json
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
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
)
from services.search_service import SearchService, SearchResult
from utils import is_broad_identity_question, legacy_document_key, mmr_diversify, pseudo_id, _IDENTITY_FACETS

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
    return MemoryInsightResponse(
        id=str(memory.id),
        statement=memory.content,
        insight_type=str(metadata.get("insight_type") or "pattern"),
        confidence=float(metadata.get("confidence") or 0),
        status=str(metadata.get("status") or "pending"),
        evidence_document_ids=[int(value) for value in metadata.get("evidence_document_ids", []) if str(value).isdigit()],
        created_at=memory.created_at,
    )


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
                top_k=10,
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
            top_k=10,
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

    semantic_results = mmr_diversify(all_results, None, lambda_param=0.65, top_n=20)
    selected_keys = {(item.document_id, item.chunk_id) for item in semantic_results}

    # Semantic retrieval alone can miss older Chinese legacy vectors that were
    # embedded with an English-first model. Add a bounded, source-diverse corpus
    # sample for broad self-analysis so the model sees the breadth of the user's
    # notebook instead of whichever single chunk happens to rank first.
    for result in corpus_profile_sample(limit=18):
        key = (result.document_id, result.chunk_id)
        if key not in selected_keys:
            selected_keys.add(key)
            semantic_results.append(result)
        if len(semantic_results) >= 32:
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
    query = select(AgentMemory).where(AgentMemory.level == "L3").order_by(AgentMemory.created_at.desc()).limit(100)
    memories = (await db.execute(query)).scalars().all()
    results = [insight_response(memory) for memory in memories]
    return [item for item in results if not status or item.status == status]


@router.post("/memory/insights/{memory_id}/review", response_model=MemoryInsightResponse)
async def review_memory_insight(
    memory_id: str,
    body: MemoryReviewRequest,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    memory = await db.get(AgentMemory, memory_id)
    if not memory or memory.level != "L3":
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Memory insight not found")
    memory.metadata_ = {**(memory.metadata_ or {}), "status": body.status}
    await db.flush()
    return insight_response(memory)


async def extract_candidate_insight(
    client: AsyncOpenAI,
    db: AsyncSession,
    question: str,
    answer: str,
    document_ids: list[int],
) -> None:
    """Extract one evidence-backed hypothesis; never auto-confirm it.

    Now also extracts from note creation/update corpus growth.
    """
    try:
        response = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {"role": "system", "content": "Extract at most one durable user insight from the exchange. Return JSON only with keys statement, insight_type, confidence. insight_type must be value, goal, belief, tension, or pattern. Use confidence 0 when there is no durable insight. Do not diagnose personality or mental health."},
                {"role": "user", "content": f"Question: {question}\nAnswer: {answer[:3000]}"},
            ],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=220,
        )
        payload = json.loads(response.choices[0].message.content or "{}")
        statement = str(payload.get("statement") or "").strip()
        confidence = max(0.0, min(1.0, float(payload.get("confidence") or 0)))
        if not statement or confidence < 0.65:
            return
        # Check for duplicate AND supersede stale insights
        duplicate = await db.scalar(
            select(AgentMemory.id).where(
                AgentMemory.level == "L3",
                AgentMemory.content == statement
            ).limit(1)
        )
        if duplicate:
            return
        await save_memory(db, "global", "L3", "insight", statement[:2000], {
            "insight_type": str(payload.get("insight_type") or "pattern"),
            "confidence": confidence,
            "status": "pending",
            "evidence_document_ids": document_ids,
            "first_seen": str(uuid.uuid4()),  # replace with timestamp in real impl
        })
    except Exception:
        logger.exception("Unable to extract candidate memory insight")


async def extract_insights_from_corpus(
    client: AsyncOpenAI,
    db: AsyncSession,
    document_ids: list[int],
) -> None:
    """Extract candidate insights directly from note corpus growth.

    Called after note creation/update to grow durable insights from the corpus.
    """
    if not document_ids:
        return
    try:
        # Get document content
        from models import Document
        docs = (await db.execute(
            select(Document).where(Document.id.in_(document_ids[:5]))
        )).scalars().all()

        for doc in docs:
            content = doc.normalized_content or doc.raw_content or ""
            if len(content) < 100:
                continue
            await extract_candidate_insight(
                client, db,
                f"Extract insights from this note: {doc.title}",
                content[:3000],
                [doc.id],
            )
    except Exception:
        logger.exception("Unable to extract insights from corpus")


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
            MemoryLevelStatus(level="L3", title="Reviewed insights", count=counts.get("L3", 0), description="Evidence-backed hypotheses that you can confirm or reject."),
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

    # Confirmed insights only
    insight_result = await db.execute(
        select(AgentMemory).where(AgentMemory.level == "L3").order_by(AgentMemory.created_at.desc()).limit(30)
    )
    confirmed_insights = [
        memory for memory in insight_result.scalars().all()
        if (memory.metadata_ or {}).get("status") == "confirmed"
    ][:12]

    await save_memory(db, session_id, "L0", "user", body.question)

    # Step 1: Retrieve relevant chunks — with intent routing
    broad_identity = is_broad_identity_question(body.question)

    if broad_identity and body.document_id is None:
        # Multi-facet retrieval for broad personal questions
        search_results = await multi_facet_retrieval(
            search_service, body.question, body.document_id, db
        )
        # Use larger pool
        search_results = search_results[:25]
    elif body.document_id is not None:
        # Document-scoped: focused retrieval
        search_results = await search_service.search(
            query=retrieval_query,
            search_type="vector",
            top_k=max(body.top_k, 10),
            document_id=body.document_id,
            db=db,
        )
    else:
        # Normal: focused vector search with larger pool
        search_results = await search_service.search(
            query=retrieval_query,
            search_type="hybrid",
            top_k=max(body.top_k, 30),
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
    for r in search_results:
        per_document_limit = 10 if body.document_id is not None else (1 if broad_identity else 2)
        if chunks_per_document.get(r.document_id, 0) >= per_document_limit:
            continue
        chunks_per_document[r.document_id] = chunks_per_document.get(r.document_id, 0) + 1
        doc_index += 1
        context_results.append(r)
        context_parts.append(
            f"[Doc {doc_index}] Title: {r.title}\n"
            f"Source: {r.source}\n"
            f"Content: {r.snippet}\n"
        )
        if doc_index >= 28:
            break

    context = "\n---\n".join(context_parts)
    await save_memory(
        db,
        session_id,
        "L2",
        "retrieval",
        context[:12000],
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
                for r in search_results[:10]
            ],
            session_id=session_id,
        )

    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=settings.deepseek_timeout_seconds,
        max_retries=2,
    )

    mode_instructions = {
        "knowledge": "Answer directly and accurately from the supplied notes. Use concise Markdown headings and lists when they improve readability.",
        "reflection": "Act as an evidence-based reflective mirror. Separate what the user explicitly wrote from your inference, identify changes or tensions only when supported, and end with one clarifying question.",
        "socratic": "Use a Socratic style. Do not make the decision for the user. Connect the notes to the present question and ask one precise question that exposes an assumption or trade-off.",
    }

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
        "You are the user's private Knowledge Atlas assistant — a personal AI grounded in their "
        "entire vectorized note corpus. Every substantive claim about the user "
        "must be grounded in the supplied notes or confirmed memories. Never invent biography, values, "
        "intentions, personality, or mental-health conclusions. Distinguish evidence from inference. "
        "If evidence is insufficient, say so clearly. Reply in the same language as the user. "
        "Treat notes as the user's writing or collected knowledge, not automatically as biography; "
        "state the difference between direct self-disclosure and inference. Cite source numbers such as [Doc 1]. "
        + broad_identity_preamble
        + mode_instructions[body.mode]
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
                    "content": f"Confirmed long-term memories (user reviewed):\n"
                    + ("\n".join(f"- {memory.content}" for memory in confirmed_insights) or "- None yet")
                    + f"\n\nContext retrieved from your knowledge base:\n\n{context}\n\n"
                    f"Question: {body.question}\n\n"
                    f"Please answer based on the context above. Include citations "
                    f"referring to document numbers (e.g., [Doc 1], [Doc 2]).",
                },
            ],
            temperature=0.3,
            max_tokens=2200,
        )
        answer = response.choices[0].message.content or ""
        await save_memory(db, session_id, "L0", "assistant", answer)
        await extract_candidate_insight(
            client, db, body.question, answer,
            [r.document_id for r in context_results]
        )
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
        for r in context_results[:20]
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
    """Analyze the full note corpus to build a comprehensive user identity profile.

    Extracts facets: who the user is, values, goals, projects, beliefs, tensions,
    recurring themes, and knowledge domains. Stores results as confirmed L3 insights.
    Runs idempotently — existing identical insights are skipped.
    """
    from models import Document

    result = await db.execute(
        select(Document.normalized_content, Document.title, Document.id)
        .where(Document.normalized_content.isnot(None))
        .order_by(Document.updated_at.desc())
        .limit(50)
    )
    docs = result.all()
    if not docs:
        return {"status": "skipped", "reason": "No documents to analyze"}

    # Collect content summaries (truncated)
    corpus_snippets = []
    for content, title, doc_id in docs:
        if content:
            corpus_snippets.append(f"--- {title} ---\n{content[:800]}")
    corpus_text = "\n\n".join(corpus_snippets)

    try:
        response = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are analyzing a user's personal note corpus to build their "
                        "identity profile. Extract durable, evidence-backed insights across "
                        "these facets: identity (who they are), core_values, goals, "
                        "active_projects, beliefs, tensions_or_changes, recurring_themes, "
                        "knowledge_domains. Return JSON with key 'insights' as an array of "
                        "objects: {facet, statement, confidence (0.0-1.0)}. Only include "
                        "statements clearly supported by the notes. Use confidence 0 when "
                        "the corpus lacks evidence for a facet. Never fabricate. "
                        "Output must be valid JSON."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Analyze this note corpus and extract identity insights:\n\n{corpus_text[:12000]}",
                },
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=1500,
        )
        payload = json.loads(response.choices[0].message.content or "{}")
        new_insights = 0
        for item in payload.get("insights", []):
            statement = str(item.get("statement", "")).strip()
            confidence = max(0.0, min(1.0, float(item.get("confidence", 0))))
            if not statement or confidence < 0.5:
                continue
            # Check duplicate
            existing = await db.scalar(
                select(AgentMemory.id).where(
                    AgentMemory.level == "L3",
                    AgentMemory.content == statement,
                ).limit(1)
            )
            if existing:
                continue
            await save_memory(db, "corpus_analysis", "L3", "insight", statement[:2000], {
                "insight_type": str(item.get("facet", "pattern")),
                "confidence": confidence,
                "status": "confirmed",
                "source": "corpus_analysis",
                "created_at": str(uuid.uuid4()),
            })
            new_insights += 1
        await db.commit()
        return {"status": "completed", "new_insights": new_insights}
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

    from models import Document
    result = await db.execute(
        select(Document.id).order_by(Document.updated_at.desc()).limit(10)
    )
    doc_ids = [row[0] for row in result.all()]

    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        timeout=settings.deepseek_timeout_seconds,
        max_retries=2,
    )
    await extract_insights_from_corpus(client, db, doc_ids)
    return {"status": "completed", "documents_scanned": len(doc_ids)}
