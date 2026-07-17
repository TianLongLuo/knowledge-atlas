"""Automatic, evidence-aware long-term memory for Atlas.

The vector store remains the source of truth for note retrieval.  This module
keeps a small, inspectable layer of durable facts and recurring patterns so the
assistant can understand the user over time without turning model guesses into
facts.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any

from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import async_session_factory
from models import AgentMemory, Document
from utils import json_object_from_model, normalized_text

logger = logging.getLogger(__name__)

MEMORY_TYPES = {
    "identity",
    "value",
    "goal",
    "project",
    "preference",
    "belief",
    "tension",
    "pattern",
    "knowledge_domain",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _now().isoformat()


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _document_ids(values: Any) -> list[int]:
    if not isinstance(values, list):
        return []
    result: list[int] = []
    for value in values:
        try:
            document_id = int(value)
        except (TypeError, ValueError):
            continue
        if document_id not in result:
            result.append(document_id)
    return result


def memory_is_stale(metadata: dict[str, Any], now: datetime | None = None) -> bool:
    """Return whether a non-pinned, time-sensitive memory should stop steering answers."""
    if metadata.get("pinned") or metadata.get("temporal_scope") == "stable":
        return False
    last_seen = _parse_datetime(metadata.get("last_seen") or metadata.get("first_seen"))
    if not last_seen:
        return False
    scope = str(metadata.get("temporal_scope") or "current")
    max_age = timedelta(days=45 if scope == "temporary" else 180)
    return (now or _now()) - last_seen > max_age


def should_auto_trust(candidate: dict[str, Any]) -> bool:
    """Only direct, high-confidence, non-sensitive user statements become facts."""
    return bool(
        candidate.get("evidence_kind") == "explicit"
        and float(candidate.get("confidence") or 0) >= 0.82
        and not candidate.get("sensitive")
    )


def memory_state(candidate: dict[str, Any], evidence_count: int | None = None) -> str:
    if candidate.get("evidence_kind") == "explicit":
        return "fact"
    count = evidence_count if evidence_count is not None else len(candidate.get("evidence_document_ids") or [])
    if count >= 2 or candidate.get("source") == "corpus":
        return "trend"
    return "hypothesis"


def memory_similarity(left: str, right: str) -> float:
    a = normalized_text(left)
    b = normalized_text(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def _clean_candidate(raw: Any, source: str, default_document_ids: list[int]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    statement = str(raw.get("statement") or "").strip()
    if len(statement) < 8:
        return None
    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence") or 0)))
    except (TypeError, ValueError):
        confidence = 0.0
    if confidence < 0.62:
        return None
    insight_type = str(raw.get("insight_type") or "pattern").strip().lower()
    if insight_type not in MEMORY_TYPES:
        insight_type = "pattern"
    evidence_kind = str(raw.get("evidence_kind") or "inferred").lower()
    if evidence_kind not in {"explicit", "inferred"}:
        evidence_kind = "inferred"
    temporal_scope = str(raw.get("temporal_scope") or "current").lower()
    if temporal_scope not in {"stable", "current", "temporary"}:
        temporal_scope = "current"
    key = str(raw.get("memory_key") or "").strip().lower()[:160]
    if not key:
        key = f"{insight_type}:{normalized_text(statement)[:80]}"
    requested_ids = _document_ids(raw.get("supporting_document_ids"))
    if source == "conversation":
        evidence_ids = []
    elif default_document_ids:
        allowed = set(default_document_ids)
        evidence_ids = [value for value in requested_ids if value in allowed] or default_document_ids
    else:
        evidence_ids = requested_ids
    return {
        "statement": statement[:2000],
        "memory_key": key,
        "insight_type": insight_type,
        "confidence": confidence,
        "evidence_kind": evidence_kind,
        "temporal_scope": temporal_scope,
        "sensitive": bool(raw.get("sensitive")),
        "evidence_document_ids": list(dict.fromkeys(evidence_ids)),
        "source": source,
    }


class MemoryAutomationService:
    """Debounced extraction plus deterministic memory merging and decay."""

    def __init__(self) -> None:
        self._note_tasks: dict[int, asyncio.Task] = {}
        self._note_versions: dict[int, int] = {}
        self._conversation_tasks: set[asyncio.Task] = set()
        self._merge_lock = asyncio.Lock()

    def _enabled(self) -> bool:
        return bool(settings.memory_automation_enabled and settings.deepseek_api_key)

    def _client(self) -> AsyncOpenAI:
        return AsyncOpenAI(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
            timeout=settings.deepseek_timeout_seconds,
            max_retries=1,
        )

    def schedule_note(self, document_id: int) -> None:
        """Debounce autosave bursts and analyze the final persisted draft."""
        if not self._enabled() or document_id <= 0:
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        self._note_versions[document_id] = self._note_versions.get(document_id, 0) + 1
        existing = self._note_tasks.get(document_id)
        if existing and not existing.done():
            return
        task = asyncio.create_task(self._run_note(document_id))
        self._note_tasks[document_id] = task
        task.add_done_callback(lambda finished, doc_id=document_id: self._finish_note(doc_id, finished))

    def _finish_note(self, document_id: int, task: asyncio.Task) -> None:
        if self._note_tasks.get(document_id) is task:
            self._note_tasks.pop(document_id, None)
            self._note_versions.pop(document_id, None)
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Automatic memory extraction failed for document %s", document_id)

    async def _run_note(self, document_id: int) -> None:
        while True:
            version = self._note_versions.get(document_id, 0)
            await asyncio.sleep(settings.memory_extraction_debounce_seconds)
            if version != self._note_versions.get(document_id, 0):
                continue
            async with async_session_factory() as db:
                document = await db.get(Document, document_id)
                if document is None:
                    return
                content = document.normalized_content or document.raw_content or ""
                if len(content.strip()) < 40:
                    return
                metadata = document.metadata_ or {}
                source_text = (
                    f"Title: {document.title}\n"
                    f"Category: {metadata.get('category') or ''}\n"
                    f"Tags: {metadata.get('tags') or ''}\n\n"
                    f"{content[:30_000]}"
                )
                await self.extract_from_text(
                    self._client(), db, source_text, "note", [document_id]
                )
                await db.commit()
            if version == self._note_versions.get(document_id, 0):
                return

    def schedule_conversation(
        self,
        session_id: str,
        user_text: str,
        evidence_document_ids: list[int],
    ) -> None:
        """Learn only from the user's words, never from the assistant's answer."""
        if not self._enabled() or len(user_text.strip()) < 20:
            return
        task = asyncio.create_task(
            self._run_conversation(session_id, user_text[:12_000], evidence_document_ids)
        )
        self._conversation_tasks.add(task)
        task.add_done_callback(self._finish_conversation)

    def _finish_conversation(self, task: asyncio.Task) -> None:
        self._conversation_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Automatic conversation memory extraction failed")

    async def _run_conversation(
        self,
        session_id: str,
        user_text: str,
        evidence_document_ids: list[int],
    ) -> None:
        await asyncio.sleep(0.5)
        async with async_session_factory() as db:
            await self.extract_from_text(
                self._client(), db, user_text, "conversation", evidence_document_ids,
                session_id=session_id,
            )
            await db.commit()

    async def extract_from_text(
        self,
        client: AsyncOpenAI,
        db: AsyncSession,
        source_text: str,
        source: str,
        document_ids: list[int],
        session_id: str = "global",
    ) -> int:
        response = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Extract durable personal memory only from the USER'S own words. Notes may contain "
                        "quotes, transcripts, research, or other people's views; do not treat those as facts "
                        "about the user. Return JSON with key memories (maximum 6). Each item must contain: "
                        "memory_key (stable category:key identifying one atomic claim), statement, insight_type (identity, value, goal, "
                        "project, preference, belief, tension, pattern, or knowledge_domain), confidence 0-1, "
                        "evidence_kind (explicit or inferred), temporal_scope (stable, current, or temporary), "
                        "and sensitive boolean. Explicit means the user directly states it. Inferred patterns "
                        "must remain cautious. Return an empty memories array when there is no durable memory. "
                        "Never diagnose personality, mental health, or protected/sensitive traits. JSON only."
                    ),
                },
                {"role": "user", "content": source_text[:30_000]},
            ],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=1000,
        )
        payload = json_object_from_model(response.choices[0].message.content or "")
        candidates = [
            cleaned
            for raw in (payload.get("memories") or [])[:6]
            if (cleaned := _clean_candidate(raw, source, document_ids)) is not None
        ]
        return await self.store_candidates(db, candidates, session_id=session_id)

    async def store_candidates(
        self,
        db: AsyncSession,
        candidates: list[dict[str, Any]],
        session_id: str = "global",
    ) -> int:
        stored = 0
        async with self._merge_lock:
            for candidate in candidates:
                if await self._upsert_candidate(db, candidate, session_id):
                    stored += 1
        return stored

    async def _upsert_candidate(
        self,
        db: AsyncSession,
        candidate: dict[str, Any],
        session_id: str,
    ) -> bool:
        memories = (
            await db.execute(
                select(AgentMemory)
                .where(AgentMemory.level == "L3")
                .order_by(AgentMemory.created_at.desc())
                .limit(500)
            )
        ).scalars().all()
        rejected_match = next(
            (
                memory for memory in memories
                if (memory.metadata_ or {}).get("status") == "rejected"
                and (
                    normalized_text(memory.content) == normalized_text(candidate["statement"])
                    or (
                        str((memory.metadata_ or {}).get("memory_key") or "") == candidate["memory_key"]
                        and memory_similarity(memory.content, candidate["statement"]) >= 0.58
                    )
                )
            ),
            None,
        )
        # Forget is durable: do not immediately relearn the same statement.
        if rejected_match:
            return False
        active = [m for m in memories if (m.metadata_ or {}).get("status") != "rejected"]
        exact = next(
            (m for m in active if normalized_text(m.content) == normalized_text(candidate["statement"])),
            None,
        )
        if exact:
            self._merge_into(exact, candidate)
            await db.flush()
            return False

        same_key = next(
            (
                m for m in active
                if str((m.metadata_ or {}).get("memory_key") or "") == candidate["memory_key"]
            ),
            None,
        )
        if same_key and memory_similarity(same_key.content, candidate["statement"]) >= 0.58:
            self._merge_into(same_key, candidate)
            await db.flush()
            return False

        conflict_with = None
        if same_key:
            conflict_with = str(same_key.id)
            old_metadata = dict(same_key.metadata_ or {})
            old_metadata["has_conflict"] = True
            same_key.metadata_ = old_metadata

        auto_trusted = should_auto_trust(candidate) and not conflict_with
        evidence_ids = candidate.get("evidence_document_ids") or []
        metadata = {
            "insight_type": candidate["insight_type"],
            "confidence": candidate["confidence"],
            "status": "confirmed" if auto_trusted else "pending",
            "memory_state": memory_state(candidate, len(evidence_ids)),
            "memory_key": candidate["memory_key"],
            "source": candidate["source"],
            "trust_source": "auto_explicit" if auto_trusted else "auto_observed",
            "evidence_kind": candidate["evidence_kind"],
            "evidence_document_ids": evidence_ids,
            "temporal_scope": candidate["temporal_scope"],
            "sensitive": candidate["sensitive"],
            "occurrences": 1,
            "first_seen": _iso_now(),
            "last_seen": _iso_now(),
            "requires_review": bool(conflict_with or candidate["sensitive"]),
            "conflict_with": conflict_with,
            "pinned": False,
        }
        db.add(AgentMemory(
            session_id=session_id or "global",
            level="L3",
            role="insight",
            content=candidate["statement"],
            metadata_=metadata,
        ))
        await db.flush()
        return True

    def _merge_into(self, memory: AgentMemory, candidate: dict[str, Any]) -> None:
        metadata = dict(memory.metadata_ or {})
        existing_ids = _document_ids(metadata.get("evidence_document_ids"))
        evidence_ids = list(dict.fromkeys(existing_ids + candidate.get("evidence_document_ids", [])))
        occurrences = int(metadata.get("occurrences") or 1) + 1
        confidence = max(float(metadata.get("confidence") or 0), float(candidate["confidence"]))
        state = memory_state(candidate, len(evidence_ids))
        if candidate.get("evidence_kind") == "inferred" and occurrences >= 2:
            state = "trend"
        metadata.update({
            "confidence": confidence,
            "evidence_document_ids": evidence_ids,
            "occurrences": occurrences,
            "last_seen": _iso_now(),
            "memory_state": state,
            "temporal_scope": candidate["temporal_scope"],
        })
        metadata.setdefault("memory_key", candidate["memory_key"])
        metadata.setdefault("source", candidate["source"])
        metadata.setdefault("first_seen", _iso_now())
        metadata.setdefault("requires_review", False)
        metadata.setdefault("pinned", False)
        if candidate["evidence_kind"] == "explicit":
            metadata["evidence_kind"] = "explicit"
        else:
            metadata.setdefault("evidence_kind", "inferred")
        metadata["sensitive"] = bool(metadata.get("sensitive") or candidate.get("sensitive"))
        if (
            metadata.get("status") == "pending"
            and should_auto_trust(candidate)
            and not metadata.get("conflict_with")
        ):
            metadata["status"] = "confirmed"
            metadata["trust_source"] = "auto_explicit"
            metadata["requires_review"] = False
        if not metadata.get("pinned") and candidate["confidence"] >= float(metadata.get("confidence") or 0):
            memory.content = candidate["statement"]
        memory.metadata_ = metadata

    async def context_memories(
        self,
        db: AsyncSession,
        trusted_limit: int = 16,
        emerging_limit: int = 8,
    ) -> tuple[list[AgentMemory], list[AgentMemory]]:
        await self.upgrade_legacy_memories(db)
        memories = (
            await db.execute(
                select(AgentMemory)
                .where(AgentMemory.level == "L3")
                .order_by(AgentMemory.created_at.desc())
                .limit(300)
            )
        ).scalars().all()
        trusted: list[AgentMemory] = []
        emerging: list[AgentMemory] = []
        for memory in memories:
            metadata = memory.metadata_ or {}
            if metadata.get("status") == "confirmed" and not memory_is_stale(metadata):
                trusted.append(memory)
            elif (
                metadata.get("status") == "pending"
                and metadata.get("memory_state") == "trend"
                and not metadata.get("requires_review")
                and float(metadata.get("confidence") or 0) >= 0.72
                and not memory_is_stale(metadata)
            ):
                emerging.append(memory)
        trusted.sort(
            key=lambda item: (
                bool((item.metadata_ or {}).get("pinned")),
                float((item.metadata_ or {}).get("confidence") or 0),
            ),
            reverse=True,
        )
        emerging.sort(
            key=lambda item: float((item.metadata_ or {}).get("confidence") or 0),
            reverse=True,
        )
        return trusted[:trusted_limit], emerging[:emerging_limit]

    async def upgrade_legacy_memories(self, db: AsyncSession) -> int:
        """Backfill lifecycle metadata and demote old auto-confirmed corpus guesses."""
        memories = (
            await db.execute(
                select(AgentMemory)
                .where(AgentMemory.level == "L3")
                .order_by(AgentMemory.created_at.desc())
                .limit(500)
            )
        ).scalars().all()
        changed = 0
        for memory in memories:
            metadata = dict(memory.metadata_ or {})
            if metadata.get("memory_state") and metadata.get("trust_source"):
                continue
            source = str(metadata.get("source") or "legacy")
            first_seen = metadata.get("first_seen")
            if not first_seen and memory.created_at:
                first_seen = memory.created_at.isoformat()
            if source == "corpus_analysis" and metadata.get("status") == "confirmed":
                metadata.update({
                    "status": "pending",
                    "memory_state": "trend",
                    "source": "corpus",
                    "trust_source": "legacy_observed",
                })
            else:
                is_confirmed = metadata.get("status") == "confirmed"
                metadata.update({
                    "memory_state": "fact" if is_confirmed else "hypothesis",
                    "trust_source": "user_confirmed" if is_confirmed else "legacy_observed",
                })
            metadata.setdefault("occurrences", 1)
            metadata.setdefault("first_seen", first_seen or _iso_now())
            metadata.setdefault("last_seen", first_seen or _iso_now())
            metadata.setdefault("requires_review", False)
            metadata.setdefault("pinned", False)
            metadata.setdefault("temporal_scope", "stable" if metadata.get("memory_state") == "fact" else "current")
            memory.metadata_ = metadata
            changed += 1
        if changed:
            await db.flush()
        return changed

    async def analyze_full_corpus(self, client: AsyncOpenAI, db: AsyncSession) -> dict[str, Any]:
        await self.upgrade_legacy_memories(db)
        rows = (
            await db.execute(
                select(Document.id, Document.title, Document.normalized_content)
                .where(Document.normalized_content.isnot(None))
                .order_by(Document.updated_at.desc())
                .limit(80)
            )
        ).all()
        snippets: list[str] = []
        scanned_ids: list[int] = []
        chars = 0
        for document_id, title, content in rows:
            if not content:
                continue
            entry = f"[Document {document_id}] {title}\n{content[:1000]}"
            if snippets and chars + len(entry) > 30_000:
                break
            snippets.append(entry)
            scanned_ids.append(document_id)
            chars += len(entry)
        if not snippets:
            return {"status": "skipped", "reason": "No documents to analyze", "new_insights": 0}
        response = await client.chat.completions.create(
            model=settings.deepseek_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Analyze the user's note corpus for durable facts and recurring themes. Notes can be "
                        "research or quotations, so do not turn a topic into a personal fact unless the user "
                        "states it directly. Return JSON with key memories (maximum 12). Each item: memory_key, "
                        "statement, insight_type, confidence, evidence_kind, temporal_scope, sensitive, and "
                        "supporting_document_ids. Use inferred for cross-note patterns and explicit only for "
                        "direct self-statements. Each memory_key must identify one atomic claim so a changed "
                        "value can be detected as a conflict. Never diagnose personality or mental health. JSON only."
                    ),
                },
                {"role": "user", "content": "\n\n---\n\n".join(snippets)},
            ],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=1800,
        )
        payload = json_object_from_model(response.choices[0].message.content or "")
        candidates = [
            cleaned
            for raw in (payload.get("memories") or [])[:12]
            if (cleaned := _clean_candidate(raw, "corpus", [])) is not None
        ]
        allowed_ids = set(scanned_ids)
        for candidate in candidates:
            candidate["evidence_document_ids"] = [
                document_id
                for document_id in candidate["evidence_document_ids"]
                if document_id in allowed_ids
            ]
        candidates = [candidate for candidate in candidates if candidate["evidence_document_ids"]]
        new_insights = await self.store_candidates(db, candidates, session_id="corpus_analysis")
        await db.commit()
        return {
            "status": "completed",
            "documents_scanned": len(scanned_ids),
            "new_insights": new_insights,
        }

    async def cancel_pending_tasks(self) -> None:
        tasks = [*self._note_tasks.values(), *self._conversation_tasks]
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._note_tasks.clear()
        self._note_versions.clear()
        self._conversation_tasks.clear()


memory_automation = MemoryAutomationService()
