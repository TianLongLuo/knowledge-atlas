"""Text chunking service.

Splits documents into overlapping chunks suitable for embedding
and retrieval, using sentence-transformers token counting.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass


@dataclass
class Chunk:
    text: str
    index: int
    hash: str
    token_count: int = 0


class ChunkingService:
    """Splits long documents into manageable chunks with overlap."""

    def __init__(
        self,
        chunk_size: int = 500,
        chunk_overlap: int = 50,
        max_chunks: int = 10_000,
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.max_chunks = max_chunks

    def chunk_text(self, text: str) -> list[Chunk]:
        """Split text into overlapping chunks.

        Uses a simple sentence-aware splitting strategy:
        1. Split by paragraphs (double newlines)
        2. For each paragraph, split into sentences
        3. Accumulate sentences until chunk_size is reached
        4. Overlap with previous chunk
        """
        if not text or not text.strip():
            return []

        # Preserve paragraph boundaries. They improve embeddings and make
        # chunk reconstruction safer for long notes.
        import re

        text = text.replace("\r\n", "\n").replace("\r", "\n")
        paragraphs = re.split(r"\n{2,}", text)

        chunks: list[Chunk] = []
        current_chunk: list[str] = []
        current_length = 0
        chunk_index = 0

        for paragraph in paragraphs:
            paragraph = paragraph.strip()
            if not paragraph:
                continue

            sentences = self._split_sentences(paragraph)

            for sentence in sentences:
                sentence_len = len(sentence)

                if current_length + sentence_len > self.chunk_size and current_chunk:
                    # Finalize current chunk
                    chunk_text = " ".join(current_chunk)
                    chunks.append(
                        Chunk(
                            text=chunk_text,
                            index=chunk_index,
                            hash=self._hash_text(chunk_text),
                            token_count=len(chunk_text.split()),
                        )
                    )
                    chunk_index += 1

                    if len(chunks) >= self.max_chunks:
                        raise ValueError(
                            f"Document exceeds the safe chunk limit ({self.max_chunks}); refusing to truncate it"
                        )

                    # Start new chunk with overlap
                    overlap_tokens = current_chunk[-self.chunk_overlap // 10 :] if self.chunk_overlap > 0 else []
                    current_chunk = overlap_tokens + [sentence]
                    current_length = sum(len(s) for s in current_chunk)
                else:
                    current_chunk.append(sentence)
                    current_length += sentence_len

        # Final chunk
        if current_chunk:
            if len(chunks) >= self.max_chunks:
                raise ValueError(
                    f"Document exceeds the safe chunk limit ({self.max_chunks}); refusing to truncate it"
                )
            chunk_text = " ".join(current_chunk)
            chunks.append(
                Chunk(
                    text=chunk_text,
                    index=chunk_index,
                    hash=self._hash_text(chunk_text),
                    token_count=len(chunk_text.split()),
                )
            )

        return chunks

    @staticmethod
    def _split_sentences(text: str) -> list[str]:
        """Simple sentence splitter based on punctuation."""
        import re

        # Split on sentence-ending punctuation followed by space and capital letter
        sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z\u4e00-\u9fff])', text)
        # Filter out empty strings
        return [s.strip() for s in sentences if s.strip()]

    @staticmethod
    def _hash_text(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]
