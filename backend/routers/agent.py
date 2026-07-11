"""Agent / AI Q&A router — RAG-powered question answering."""

from __future__ import annotations

import logging
import json
import uuid

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
from services.search_service import SearchService

router = APIRouter(prefix="/api/agent", tags=["agent"])
logger = logging.getLogger(__name__)


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
    """Extract one evidence-backed hypothesis; never auto-confirm it."""
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
        duplicate = await db.scalar(select(AgentMemory.id).where(AgentMemory.level == "L3", AgentMemory.content == statement).limit(1))
        if duplicate:
            return
        await save_memory(db, "global", "L3", "insight", statement[:2000], {
            "insight_type": str(payload.get("insight_type") or "pattern"),
            "confidence": confidence,
            "status": "pending",
            "evidence_document_ids": document_ids,
        })
    except Exception:
        logger.exception("Unable to extract candidate memory insight")


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


@router.post("/ask", response_model=AskResponse)
async def ask_question(
    body: AskRequest,
    db: AsyncSession = Depends(get_db),
    _user: str = Depends(get_current_user),
):
    """RAG-powered Q&A using ChromaDB retrieval + DeepSeek.

    Flow:
    1. Retrieve top-k relevant chunks from ChromaDB via vector search
    2. Assemble context from the chunks
    3. Call DeepSeek chat API with context + question
    4. Return answer with citations
    """
    search_service = SearchService()
    session_id = body.session_id or uuid.uuid4().hex

    history_result = await db.execute(
        select(AgentMemory)
        .where(AgentMemory.session_id == session_id, AgentMemory.level == "L0")
        .order_by(AgentMemory.created_at.desc())
        .limit(8)
    )
    recent_history = list(reversed(history_result.scalars().all()))
    insight_result = await db.execute(
        select(AgentMemory).where(AgentMemory.level == "L3").order_by(AgentMemory.created_at.desc()).limit(30)
    )
    confirmed_insights = [
        memory for memory in insight_result.scalars().all()
        if (memory.metadata_ or {}).get("status") == "confirmed"
    ][:12]
    await save_memory(db, session_id, "L0", "user", body.question)

    # Step 1: Retrieve relevant chunks
    search_results = await search_service.search(
        query=body.question,
        search_type="vector",
        top_k=body.top_k,
        document_id=body.document_id,
        db=db,
    )
    if not search_results:
        answer = "I couldn't find any relevant information in the vector knowledge base to answer this question."
        await save_memory(db, session_id, "L0", "assistant", answer)
        return AskResponse(
            question=body.question,
            answer=answer,
            citations=[],
            session_id=session_id,
        )

    # Step 2: Build context string
    context_parts = []
    for i, r in enumerate(search_results):
        context_parts.append(
            f"[Document {i+1}] Title: {r.title}\n"
            f"Source: {r.source}\n"
            f"Content: {r.snippet}\n"
        )
    context = "\n---\n".join(context_parts)
    await save_memory(
        db,
        session_id,
        "L2",
        "retrieval",
        context[:12000],
        {"document_ids": [r.document_id for r in search_results], "query": body.question},
    )

    # Step 3: Call DeepSeek
    if not settings.deepseek_api_key:
        # Fallback: return search results without AI synthesis
        answer = (
            "AI synthesis is unavailable (DeepSeek API key not configured). "
            "Here are the most relevant documents from the vector knowledge base:\n\n"
            + "\n".join(f"- **{r.title}**: {r.snippet[:200]}..." for r in search_results)
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
                for r in search_results
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
        "knowledge": "Answer directly and accurately from the supplied notes.",
        "reflection": "Act as an evidence-based reflective mirror. Separate what the user explicitly wrote from your inference, identify changes or tensions only when supported, and end with one clarifying question.",
        "socratic": "Use a Socratic style. Do not make the decision for the user. Connect the notes to the present question and ask one precise question that exposes an assumption or trade-off.",
    }
    system_prompt = (
        "You are the user's private Knowledge Atlas assistant. Every substantive claim about the user "
        "must be grounded in the supplied notes or confirmed memories. Never invent biography, values, "
        "intentions, personality, or mental-health conclusions. Distinguish evidence from inference. "
        "If evidence is insufficient, say so. Cite source numbers such as [Doc 1]. "
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
                    + f"\n\nContext retrieved from vector knowledge base:\n\n{context}\n\n"
                    f"Question: {body.question}\n\n"
                    f"Please answer based on the context above. Include citations "
                    f"referring to document numbers (e.g., [Doc 1], [Doc 2]).",
                },
            ],
            temperature=0.3,
            max_tokens=1500,
        )
        answer = response.choices[0].message.content or ""
        await save_memory(db, session_id, "L0", "assistant", answer)
        await extract_candidate_insight(
            client, db, body.question, answer, [result.document_id for result in search_results]
        )
    except Exception as exc:
        logger.exception("DeepSeek request failed; verify DeepSeek server configuration")
        diagnostic = deepseek_error_message(exc)
        answer = (
            f"DeepSeek is temporarily unavailable: {diagnostic}\n\n"
            "The vector database is working. These are the most relevant notes:\n\n"
            + "\n".join(f"- **{r.title}**: {r.snippet[:240]}..." for r in search_results)
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
                for r in search_results
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
        for r in search_results
    ]

    return AskResponse(
        question=body.question,
        answer=answer,
        citations=citations,
        session_id=session_id,
    )
