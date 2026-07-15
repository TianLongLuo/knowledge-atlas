"""Tests for canonical knowledge write path, deduplication, agent routing."""

from auth import create_access_token, decode_access_token, hash_password, verify_password
from utils import (
    pseudo_id, normalize_document_id,
    is_broad_identity_question, mmr_diversify, _IDENTITY_FACETS,
    content_snippet, dominant_group, normalized_source_type, normalized_tags,
    content_fingerprint, legacy_document_key, merge_chunk_texts,
)
from schemas import AskRequest, SearchResult
from pydantic import ValidationError
import pytest


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


def test_legacy_duplicate_rows_share_one_logical_identity():
    meta = {"source": "flomo", "title": "同一篇笔记", "timestamp": "2026-07-04T08:00:00"}
    first = legacy_document_key("random-a", meta, "相同内容")
    second = legacy_document_key("random-b", meta, "相同内容")
    assert first == second
    assert legacy_document_key("a", {**meta, "source_id": "import-1"}, "相同内容") == legacy_document_key(
        "b", {**meta, "source_id": "import-2"}, "相同内容"
    )
    assert content_fingerprint(" 标题 ", "a  b", "flomo") == content_fingerprint("标题", "a b", "FLOMO")


def test_chunk_families_and_overlap_reconstruct_complete_note():
    meta = {"source": "notion", "title": "Long note", "chunk_index": 0}
    assert legacy_document_key("note_chunk_0", meta, "first") == legacy_document_key("note_chunk_1", meta, "second")
    assert merge_chunk_texts(["one two three shared overlap text", "shared overlap text and the ending"]) == "one two three shared overlap text and the ending"
    assert merge_chunk_texts(["same", "same", "different"]) == "same\n\ndifferent"
    assert merge_chunk_texts(["repeat", "middle", "repeat"]) == "repeat\n\nmiddle\n\nrepeat"


def test_chunking_keeps_the_tail_after_two_hundred_chunks():
    from services.chunking import ChunkingService

    long_note = "\n\n".join(
        f"Section {index}. " + ("x" * 470) + (" FINAL-TAIL" if index == 239 else "")
        for index in range(240)
    )
    chunks = ChunkingService(chunk_size=500, chunk_overlap=0).chunk_text(long_note)
    assert len(chunks) >= 239
    assert "FINAL-TAIL" in chunks[-1].text


def test_document_detail_prefers_complete_reconstructed_content():
    from routers.documents import _longest_document_content

    rebuilt = "full content " * 1000
    assert _longest_document_content("short preview", "title only", rebuilt) == rebuilt


def test_notion_nested_pagination_is_complete_and_strict():
    import asyncio
    from types import SimpleNamespace
    from services.notion_sync import NotionSyncService

    class Children:
        async def list(self, block_id, start_cursor=None, **_kwargs):
            if block_id == "page" and start_cursor is None:
                return {"results": [{"id": "a", "type": "paragraph", "paragraph": {"rich_text": []}}], "has_more": True, "next_cursor": "next"}
            if block_id == "page" and start_cursor == "next":
                return {"results": [{"id": "b", "type": "paragraph", "paragraph": {"rich_text": []}}], "has_more": False}
            raise RuntimeError("unexpected request")

    notion = SimpleNamespace(blocks=SimpleNamespace(children=Children()))
    blocks = asyncio.run(NotionSyncService()._fetch_blocks_recursive(notion, "page"))
    assert [block["id"] for block in blocks] == ["a", "b"]

    class BrokenChildren:
        async def list(self, **_kwargs):
            raise RuntimeError("temporary Notion failure")

    broken = SimpleNamespace(blocks=SimpleNamespace(children=BrokenChildren()))
    with pytest.raises(RuntimeError, match="temporary Notion failure"):
        asyncio.run(NotionSyncService()._fetch_blocks_recursive(broken, "page"))


def test_notion_inbound_sync_preserves_atlas_tags_without_tag_property():
    from services.notion_sync import NotionSyncService

    service = NotionSyncService()
    properties = {
        "Name": {"type": "title", "title": []},
        "Category": {"type": "select", "select": {"name": "Research"}},
    }
    has_tags, notion_tags = service._extract_tag_property(properties)
    merged = service._merge_notion_metadata(
        {"tags": "AI, research", "category": "Work", "local_only": True},
        {"notion_page_id": "page-1"},
        has_tags,
        notion_tags,
    )

    assert has_tags is False
    assert merged["tags"] == "AI, research"
    assert merged["category"] == "Work"
    assert merged["local_only"] is True


def test_notion_inbound_sync_accepts_explicit_empty_or_populated_tags():
    from services.notion_sync import NotionSyncService

    service = NotionSyncService()
    has_tags, notion_tags = service._extract_tag_property({
        "标签": {"type": "multi_select", "multi_select": [{"name": "英语"}, {"name": "练习"}]},
    })
    assert has_tags is True
    assert notion_tags == ["英语", "练习"]
    assert service._merge_notion_metadata(
        {"tags": "old"}, {}, has_tags, notion_tags,
    )["tags"] == ["英语", "练习"]

    has_tags, notion_tags = service._extract_tag_property({
        "Tags": {"type": "multi_select", "multi_select": []},
    })
    assert has_tags is True
    assert service._merge_notion_metadata(
        {"tags": "old"}, {}, has_tags, notion_tags,
    )["tags"] == []


def test_notion_writeback_discovers_real_title_property_and_optional_fields(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from services.note_service import NoteService
    from config import settings

    monkeypatch.setattr(settings, "notion_database_id", "database-1")

    class Databases:
        calls = 0

        async def retrieve(self, database_id):
            assert database_id == "database-1"
            self.calls += 1
            return {"properties": {
                "标题": {"type": "title"},
                "标签": {"type": "multi_select"},
                "分类": {"type": "select"},
            }}

    databases = Databases()
    service = NoteService()
    notion = SimpleNamespace(databases=databases)
    first = asyncio.run(service._get_notion_database_schema(notion))
    second = asyncio.run(service._get_notion_database_schema(notion))

    assert first == {"title": "标题", "tags": "标签", "category": "分类"}
    assert second == first
    assert databases.calls == 1

    document = SimpleNamespace(
        title="网站创建的笔记",
        metadata_={"tags": "研究, 市场", "category": "工作"},
    )
    properties = service._notion_page_properties(document, first)
    assert properties["标题"]["title"][0]["text"]["content"] == "网站创建的笔记"
    assert properties["标签"]["multi_select"] == [{"name": "研究"}, {"name": "市场"}]
    assert properties["分类"]["select"] == {"name": "工作"}


def test_notion_writeback_creates_missing_tags_property(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from services.note_service import NoteService
    from config import settings

    monkeypatch.setattr(settings, "notion_database_id", "database-without-tags")

    class Databases:
        def __init__(self):
            self.updated = None

        async def retrieve(self, database_id):
            assert database_id == "database-without-tags"
            return {"properties": {"Name": {"type": "title"}}}

        async def update(self, database_id, properties):
            self.updated = {"database_id": database_id, "properties": properties}
            return {"id": database_id}

    databases = Databases()
    service = NoteService()
    schema = asyncio.run(service._get_notion_database_schema(SimpleNamespace(databases=databases)))

    assert schema["tags"] == "Tags"
    assert databases.updated == {
        "database_id": "database-without-tags",
        "properties": {"Tags": {"multi_select": {}}},
    }


def test_notion_writeback_replaces_old_blocks_and_writes_every_batch():
    import asyncio
    from types import SimpleNamespace
    from services.note_service import NoteService

    class Children:
        def __init__(self):
            self.appended = []

        async def list(self, block_id, start_cursor=None, page_size=100):
            assert block_id == "page-1"
            assert page_size == 100
            if start_cursor is None:
                return {"results": [{"id": "old-1"}], "has_more": True, "next_cursor": "next"}
            return {"results": [{"id": "old-2"}], "has_more": False, "next_cursor": None}

        async def append(self, block_id, children):
            assert block_id == "page-1"
            self.appended.append(children)
            return {"results": []}

    class Blocks:
        def __init__(self):
            self.children = Children()
            self.deleted = []

        async def delete(self, block_id):
            self.deleted.append(block_id)
            return {"id": block_id, "archived": True}

    blocks = Blocks()
    notion = SimpleNamespace(blocks=blocks)
    content_blocks = NoteService._content_to_notion_blocks("x" * (1900 * 205))
    asyncio.run(NoteService()._replace_notion_page_content(notion, "page-1", content_blocks))

    assert blocks.deleted == ["old-1", "old-2"]
    assert [len(batch) for batch in blocks.children.appended] == [100, 100, 5]
    assert sum(len(batch) for batch in blocks.children.appended) == len(content_blocks)


def test_legacy_document_listing_collapses_duplicates_and_rebuilds_chunks(monkeypatch):
    from routers import documents as documents_router

    class FakeCollection:
        def get(self, **_kwargs):
            return {
                "ids": ["duplicate-a", "duplicate-b", "long_chunk_0", "long_chunk_1"],
                "documents": ["same note", "same note", "first half shared overlap", "shared overlap second half"],
                "metadatas": [
                    {"source": "flomo", "title": "Duplicate"},
                    {"source": "flomo", "title": "Duplicate"},
                    {"source": "notion", "title": "Long", "chunk_index": 0},
                    {"source": "notion", "title": "Long", "chunk_index": 1},
                ],
            }

    monkeypatch.setattr(documents_router, "get_chroma_collection", lambda: FakeCollection())
    items = documents_router._get_legacy_chroma_docs()
    assert len(items) == 2
    duplicate = next(item for item in items if item["title"] == "Duplicate")
    assert len(duplicate["chroma_real_ids"]) == 2
    assert duplicate["raw_content"] == "same note"
    long_note = next(item for item in items if item["title"] == "Long")
    assert long_note["raw_content"] == "first half shared overlap second half"


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


def test_agent_allows_up_to_one_hundred_retrieval_candidates():
    assert AskRequest(question="我是谁").top_k == 100
    assert AskRequest(question="test", top_k=100).top_k == 100
    with pytest.raises(ValidationError):
        AskRequest(question="test", top_k=101)


def test_graph_keeps_one_sided_threshold_qualified_links():
    from routers.graph import _proposal_edges

    proposals = {
        ("a", "b"): {"weight": 0.61, "directions": {"a"}},
        ("b", "c"): {"weight": 0.73, "directions": {"b", "c"}},
    }
    edges = _proposal_edges(proposals, max_edges=10)
    assert [(edge.source, edge.target) for edge in edges] == [("b", "c"), ("a", "b")]


def test_dashboard_and_document_list_share_postgres_deduplication():
    from models import Document
    from routers.documents import _deduplicate_postgres_documents

    documents = [
        Document(source_type="flomo", source_id="note-1", title="Older", raw_content="same"),
        Document(source_type="flomo", source_id="note-1", title="Newer", raw_content="same"),
        Document(source_type="manual", title="Standalone", raw_content="unique"),
        Document(source_type="manual", title="Standalone", raw_content="unique"),
    ]

    unique = _deduplicate_postgres_documents(documents)
    assert [document.title for document in unique] == ["Older", "Standalone"]


def test_document_note_date_prefers_source_metadata():
    from routers.documents import _document_datetime
    from schemas import DocumentResponse

    document = DocumentResponse(
        id=1,
        source_type="notion",
        title="Dated note",
        metadata={"created_time": "2024-02-03T10:30:00Z"},
        created_at="2026-07-12T10:00:00Z",
    )

    assert _document_datetime(document, "note_date").isoformat() == "2024-02-03T10:30:00+00:00"
    assert _document_datetime(document, "system_created").isoformat() == "2026-07-12T10:00:00+00:00"


def test_document_search_includes_category_and_tags():
    from routers.documents import _document_matches_search
    from schemas import DocumentResponse

    document = DocumentResponse(
        id=7, source_type="manual", title="A plain title", raw_content="ordinary body",
        metadata={"category": "Business", "tags": "pricing, strategy"},
    )
    assert _document_matches_search(document, "Business")
    assert _document_matches_search(document, "pricing")
    assert not _document_matches_search(document, "grammar")


def test_graph_composite_score_uses_metadata_only_as_semantic_boost():
    from routers.graph import GraphNode, _composite_link_score

    source = GraphNode(id="a", label="A", group="Business", document_id=1, tags=["pricing"])
    related = GraphNode(id="b", label="B", group="Business", document_id=2, tags=["pricing"])
    unrelated = GraphNode(id="c", label="C", group="Business", document_id=3, tags=["pricing"])

    boosted = _composite_link_score(0.36, source, related, 0.45)
    assert boosted is not None and boosted[0] > 0.36
    assert _composite_link_score(0.05, source, unrelated, 0.45) is None


def test_graph_links_cross_language_speaking_practice_topics():
    from routers.graph import GraphNode, _composite_link_score

    chinese = GraphNode(
        id="cn", label="英语口语练习", snippet="每天跟读并复述", group="学习", document_id=1,
    )
    english = GraphNode(
        id="en", label="Daily speaking practice", snippet="Shadowing an English conversation", group="学习", document_id=2,
    )
    scored = _composite_link_score(0.17, chinese, english, 0.45)
    assert scored is not None
    assert "english-speaking" in scored[1]


def test_legacy_document_route_key_survives_content_edits():
    assert legacy_document_key(
        "legacy-row", {"atlas_legacy_key": "content:original"}, "completely rewritten text"
    ) == "content:original"


def test_tag_suggestion_requires_external_processing_consent():
    from schemas import TagSuggestRequest

    with pytest.raises(ValidationError):
        TagSuggestRequest(title="Draft", content="Body")
    assert TagSuggestRequest(
        title="Draft", content="Body", allow_external_processing=True
    ).allow_external_processing is True


def test_writing_assist_requires_explicit_external_processing_consent():
    from schemas import WritingAssistRequest

    with pytest.raises(ValidationError):
        WritingAssistRequest(title="Draft", content="This is long enough for review.")
    request = WritingAssistRequest(
        title="Draft",
        content="This is long enough for review.",
        allow_external_processing=True,
    )
    assert request.allow_external_processing is True


def test_writing_assist_parses_fenced_json():
    from utils import json_object_from_model

    parsed = json_object_from_model('```json\n{"suggested_titles": ["One"]}\n```')
    assert parsed["suggested_titles"] == ["One"]


def test_writing_assist_limits_external_draft_and_history(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from routers import agent
    from schemas import WritingAssistRequest

    captured: dict = {}

    async def fake_search(self, **_kwargs):
        return [
            SearchResult(
                title=f"Reference {index}", snippet="s" * 400, source="manual",
                source_type="manual", similarity_score=0.9 - index * 0.01,
                document_id=index, chunk_id=f"chunk-{index}",
            )
            for index in range(1, 8)
        ]

    class FakeClient:
        def __init__(self, **_kwargs):
            self.chat = self
            self.completions = self

        async def create(self, **kwargs):
            captured.update(kwargs)
            message = SimpleNamespace(content='{"suggested_titles":["Better title"],"directions":[],"logic_issues":[],"grammar_issues":[]}')
            return SimpleNamespace(choices=[SimpleNamespace(message=message)])

    monkeypatch.setattr(agent.SearchService, "search", fake_search)
    monkeypatch.setattr(agent, "AsyncOpenAI", FakeClient)
    monkeypatch.setattr(agent.settings, "deepseek_api_key", "test-key")
    response = asyncio.run(agent.writing_assist(
        WritingAssistRequest(
            title="Draft", content="x" * 40_000, document_id=1,
            allow_external_processing=True,
        ),
        db=object(), _user="test",
    ))

    outbound = captured["messages"][1]["content"]
    assert "x" * 30_000 in outbound
    assert "x" * 30_001 not in outbound
    assert outbound.count("Reference ") == 10  # title + label for five references
    assert len(response.historical_references) == 5
    assert response.suggested_titles == ["Better title"]
