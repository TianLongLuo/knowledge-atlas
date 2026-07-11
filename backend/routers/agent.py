"""Agent / AI Q&A router — RAG-powered question answering."""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from auth import get_current_user
from database import get_db
from config import settings
from database import get_chroma_collection
from schemas import AgentStatusResponse, AskRequest, AskResponse, Citation
from services.search_service import SearchService

router = APIRouter(prefix="/api/agent", tags=["agent"])
logger = logging.getLogger(__name__)


@router.get("/status", response_model=AgentStatusResponse)
async def agent_status(_user: str = Depends(get_current_user)):
    """Expose readiness without exposing credentials or provider responses."""
    try:
        vector_count = get_chroma_collection().count()
    except Exception:
        logger.exception("Unable to inspect ChromaDB for agent readiness")
        vector_count = 0
    return AgentStatusResponse(
        deepseek_configured=bool(settings.deepseek_api_key),
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

    # Step 1: Retrieve relevant chunks
    search_results = await search_service.search(
        query=body.question,
        search_type="vector",
        top_k=body.top_k,
        document_id=body.document_id,
        db=db,
    )
    session_id = body.session_id or uuid.uuid4().hex

    if not search_results:
        return AskResponse(
            question=body.question,
            answer="I couldn't find any relevant information in the knowledge base to answer this question.",
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

    # Step 3: Call DeepSeek
    from openai import AsyncOpenAI

    if not settings.deepseek_api_key:
        # Fallback: return search results without AI synthesis
        return AskResponse(
            question=body.question,
            answer="AI synthesis is unavailable (DeepSeek API key not configured). "
            "Here are the most relevant documents from the knowledge base:\n\n"
            + "\n".join(
                f"- **{r.title}**: {r.snippet[:200]}..." for r in search_results
            ),
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

    system_prompt = (
        "You are a helpful knowledge assistant. Answer the user's question based ONLY "
        "on the provided document context. If the context doesn't contain enough "
        "information to answer the question confidently, say so explicitly. "
        "Always cite which documents you used. Be concise and accurate."
    )

    try:
        response = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": f"Context from knowledge base:\n\n{context}\n\n"
                    f"Question: {body.question}\n\n"
                    f"Please answer based on the context above. Include citations "
                    f"referring to document numbers (e.g., [Doc 1], [Doc 2]).",
                },
            ],
            temperature=0.3,
            max_tokens=1500,
        )
        answer = response.choices[0].message.content or ""
    except Exception as exc:
        logger.exception("DeepSeek request failed; verify DeepSeek server configuration")
        raise HTTPException(
            status_code=502,
            detail="DeepSeek 请求失败。请检查服务器的 DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、DEEPSEEK_MODEL，然后重启后端。",
        ) from exc

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
