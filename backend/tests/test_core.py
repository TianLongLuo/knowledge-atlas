"""Tests for canonical knowledge write path, deduplication, agent routing."""

from auth import create_access_token, decode_access_token, hash_password, verify_password
from utils import (
    pseudo_id, normalize_document_id,
    is_broad_identity_question, mmr_diversify, _IDENTITY_FACETS,
    content_snippet, dominant_group, normalized_source_type, normalized_tags,
)
from schemas import SearchResult


# ── Auth tests ────────────────────────────────────────────────────

def test_password_and_token_round_trip():
    hashed = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", hashed)
    assert not verify_password("wrong", hashed)
    assert decode_access_token(create_access_token("admin")) == "admin"


# ── Pseudo ID tests ───────────────────────────────────────────────

def test_pseudo_ids_are_stable_negative_and_distinct():
    first = pseudo_id("chroma-a")
    assert first < 0
    assert first == pseudo_id("chroma-a")
    assert first != pseudo_id("chroma-b")
    assert abs(first) < 2**52


# ── Document ID normalization tests ───────────────────────────────

def test_normalize_document_id_handles_all_forms():
    assert normalize_document_id("123") == 123
    assert normalize_document_id(456) == 456
    assert normalize_document_id(None) == 0
    assert normalize_document_id("not_a_number") == 0
    assert normalize_document_id("") == 0
    assert normalize_document_id("0") == 0


# ── Graph classification tests ────────────────────────────────────

def test_graph_classification_and_snippet_are_deterministic():
    assert dominant_group("Python Docker API 架构", "后端", {}) == "技术"
    assert dominant_group("anything", "title", {"category": "自定义"}) == "自定义"
    assert content_snippet("a   b\n c", 20) == "a b c"


def test_graph_source_types_and_tags_are_normalized():
    assert normalized_source_type("flomo 75", {}) == "Imported"
    assert normalized_source_type("anything", {"source_type": "notion"}) == "Notion"
    assert normalized_source_type("mystery", {}) == "Unknown"
    assert normalized_tags({"tags": "business，growth, business"}) == ["business", "growth"]


# ── Query-intent routing tests ────────────────────────────────────

def test_identity_question_detection_english():
    assert is_broad_identity_question("Who am I?") is True
    assert is_broad_identity_question("What do I believe?") is True
    assert is_broad_identity_question("What are my goals?") is True
    assert is_broad_identity_question("What am I working toward?") is True
    assert is_broad_identity_question("Tell me about myself") is True
    assert is_broad_identity_question("What kind of person am I?") is True
    assert is_broad_identity_question("What defines me?") is True
    assert is_broad_identity_question("What do I value?") is True


def test_identity_question_detection_chinese():
    assert is_broad_identity_question("我是谁？") is True
    assert is_broad_identity_question("我的价值观是什么") is True
    assert is_broad_identity_question("我相信什么") is True
    assert is_broad_identity_question("我的目标") is True
    assert is_broad_identity_question("了解我自己") is True


def test_normal_questions_not_identity():
    assert is_broad_identity_question("How do I set up a Docker container?") is False
    assert is_broad_identity_question("What is the capital of France?") is False
    assert is_broad_identity_question("Summarize this document") is False
    assert is_broad_identity_question("") is False


def test_identity_facets_are_well_formed():
    """All identity facets must have unique names and non-empty queries."""
    names = [f[0] for f in _IDENTITY_FACETS]
    assert len(names) == len(set(names)), "Facet names must be unique"
    for name, query in _IDENTITY_FACETS:
        assert name, f"Facet name must not be empty"
        assert len(query) > 10, f"Facet '{name}' query is too short: {query}"


# ── MMR diversity tests ───────────────────────────────────────────

def test_mmr_diversify_empty_and_single():
    assert mmr_diversify([], None) == []
    r = SearchResult(
        title="Test", snippet="snippet", source="manual",
        similarity_score=0.9, document_id=1, chunk_id="c1",
    )
    assert mmr_diversify([r], None) == [r]


def test_mmr_diversify_deduplicates_documents():
    """MMR should prefer results from different documents."""
    results = [
        SearchResult(title=f"Doc {i}", snippet="s", source="manual",
                     similarity_score=0.9, document_id=1, chunk_id=f"c{i}")
        for i in range(5)
    ]
    results += [
        SearchResult(title="Doc B", snippet="s", source="manual",
                     similarity_score=0.8, document_id=2, chunk_id="cb1")
    ]
    # Sort by relevance
    results.sort(key=lambda x: x.similarity_score, reverse=True)
    diverse = mmr_diversify(results, None, lambda_param=0.7, top_n=5)
    doc_ids = [r.document_id for r in diverse]
    # Should include both documents
    assert 2 in doc_ids, "MMR should include results from document 2"
    assert 1 in doc_ids, "MMR should include results from document 1"


def test_mmr_diversify_handles_all_same_document():
    """When all results are from one document, MMR should still return results."""
    results = [
        SearchResult(title=f"Chunk {i}", snippet="s", source="manual",
                     similarity_score=0.9 - i * 0.1, document_id=1, chunk_id=f"c{i}")
        for i in range(10)
    ]
    diverse = mmr_diversify(results, None, top_n=5)
    assert len(diverse) >= 1, "Should return at least one result"
    assert all(r.document_id == 1 for r in diverse)


def test_mmr_diversify_keeps_legacy_vector_notes_distinct():
    """Legacy notes must use stable negative IDs instead of all becoming doc 0."""
    results = [
        SearchResult(title=f"Legacy {i}", snippet="s", source="flomo",
                     similarity_score=0.9 - i * 0.01,
                     document_id=pseudo_id(f"legacy-{i}"), chunk_id=f"legacy-{i}")
        for i in range(8)
    ]
    diverse = mmr_diversify(results, None, top_n=6)
    assert len(diverse) == 6
    assert len({item.document_id for item in diverse}) == 6


# ── SearchService import check ────────────────────────────────────

def test_search_result_schema_is_valid():
    """Verify SearchResult can be constructed with all fields."""
    r = SearchResult(
        title="Test Document",
        snippet="This is a test snippet",
        source="manual",
        source_type="manual",
        similarity_score=0.95,
        document_id=42,
        chunk_id="chunk_001",
        url="https://example.com",
    )
    assert r.document_id == 42
    assert r.similarity_score == 0.95
    assert r.title == "Test Document"
