"""Validated runtime configuration for Knowledge Atlas."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from urllib.parse import quote_plus

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration sourced from environment variables or ``backend/.env``.

    Secrets intentionally have no usable production defaults.  A fresh deploy
    therefore fails early instead of silently running with public credentials.
    """

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parent / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    environment: str = "development"
    postgres_host: str = "127.0.0.1"
    postgres_port: int = Field(default=5432, ge=1, le=65535)
    postgres_user: str = "atlas"
    postgres_password: str = "change-me-in-env"
    postgres_db: str = "knowledge_atlas"

    chroma_data_path: str = str(Path(__file__).resolve().parent / "data" / "chroma")
    chroma_collection_name: str = "knowledge_atlas"

    notion_api_key: str = ""
    notion_database_id: str = ""
    notion_auto_sync_enabled: bool = True
    notion_auto_sync_interval_minutes: int = Field(default=5, ge=1, le=1440)
    notion_writeback_debounce_seconds: float = Field(default=3.0, ge=0.5, le=60)
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com/v1"
    deepseek_model: str = "deepseek-chat"
    deepseek_timeout_seconds: float = Field(default=45, ge=5, le=180)
    memory_automation_enabled: bool = True
    memory_extraction_debounce_seconds: float = Field(default=12, ge=1, le=300)
    memory_profile_interval_minutes: int = Field(default=360, ge=15, le=10080)
    redis_url: str = "redis://127.0.0.1:6379/0"

    secret_key: str = "change-me-in-env-with-at-least-32-random-characters"
    admin_username: str = "admin"
    admin_password_hash: str = ""
    access_token_expire_minutes: int = Field(default=480, ge=5, le=43200)
    session_cookie_secure: bool = False

    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)
    debug: bool = False
    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    embedding_model: str = "all-MiniLM-L6-v2"
    graph_default_limit: int = Field(default=180, ge=10, le=500)
    graph_max_edges: int = Field(default=450, ge=10, le=5000)
    graph_neighbors_per_node: int = Field(default=6, ge=2, le=50)

    @field_validator("cors_origins")
    @classmethod
    def reject_wildcard_cors(cls, value: list[str]) -> list[str]:
        cleaned = [origin.rstrip("/") for origin in value if origin.strip()]
        if "*" in cleaned:
            raise ValueError("CORS_ORIGINS cannot contain '*' when credentials are enabled")
        return cleaned

    @model_validator(mode="after")
    def validate_production_secrets(self) -> "Settings":
        if self.environment.lower() in {"production", "prod"}:
            if self.postgres_password.startswith("change-me"):
                raise ValueError("POSTGRES_PASSWORD must be set in production")
            if self.secret_key.startswith("change-me") or len(self.secret_key) < 32:
                raise ValueError("SECRET_KEY must be a random value of at least 32 characters")
            if not self.admin_password_hash:
                raise ValueError("ADMIN_PASSWORD_HASH must be set in production")
        return self

    @property
    def database_url(self) -> str:
        password = quote_plus(self.postgres_password)
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def database_url_sync(self) -> str:
        password = quote_plus(self.postgres_password)
        return (
            f"postgresql+psycopg2://{self.postgres_user}:{password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
