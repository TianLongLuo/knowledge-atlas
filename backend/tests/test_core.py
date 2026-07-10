from auth import create_access_token, decode_access_token, hash_password, verify_password
from routers.documents import _pseudo_id
from routers.graph import content_snippet, dominant_group


def test_password_and_token_round_trip():
    hashed = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", hashed)
    assert not verify_password("wrong", hashed)
    assert decode_access_token(create_access_token("admin")) == "admin"


def test_pseudo_ids_are_stable_negative_and_distinct():
    first = _pseudo_id("chroma-a")
    assert first < 0
    assert first == _pseudo_id("chroma-a")
    assert first != _pseudo_id("chroma-b")


def test_graph_classification_and_snippet_are_deterministic():
    assert dominant_group("Python Docker API 架构", "后端", {}) == "技术"
    assert dominant_group("anything", "title", {"category": "自定义"}) == "自定义"
    assert content_snippet("a   b\n c", 20) == "a b c"
