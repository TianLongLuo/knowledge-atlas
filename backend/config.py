"""Central configuration for Knowledge Atlas backend.

Loads settings from environment / .env file using pydantic-settings.
"""

from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings sourced from environment / .env."""

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parent / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── PostgreSQL ──────────────────────────────────────────────────
    postgres_host: str = "127.0.0.1"
    postgres_port: int = 5432
    postgres_user: str = "atlas"
    postgres_password: str = "atlas_knowledge_2026"
    postgres_db: str = "knowledge_atlas"

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def database_url_sync(self) -> str:
        return (
            f"postgresql+psycopg2://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    # ── ChromaDB ────────────────────────────────────────────────────
    chroma_data_path: str = "/root/.hermes/knowledge_db/chroma_data"
    chroma_collection_name: str = "hermes_knowledge"

    # ── Notion ──────────────────────────────────────────────────────
    notion_api_key: str = ""
    notion_database_id: str = ""

    # ── DeepSeek ────────────────────────────────────────────────────
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com/v1"

    # ── Redis ───────────────────────────────────────────────────────
    redis_url: str = "redis://127.0.0.1:6379/0"

    # ── Auth ────────────────────────────────────────────────────────
    secret_key: str = "knowledge-atlas-jwt-secret-key-2026"
    admin_username: str = "admin"
    admin_password_hash: str = ""
    access_token_expire_minutes: int = 480  # 8 hours

    # ── Server ──────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = False

    # ── Embedding ───────────────────────────────────────────────────
    embedding_model: str = "all-MiniLM-L6-v2"


# Singleton
settings = Settings()
