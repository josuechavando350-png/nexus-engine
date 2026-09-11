from __future__ import annotations

import asyncio
import math
import os
from functools import lru_cache


class BertEmbeddingEngine:
    """Optional offline BERT-family adapter; intentionally lazy so it never enters the web request path."""

    def __init__(self, model_name: str | None = None) -> None:
        self.model_name = model_name or os.getenv(
            "BERT_EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
        )

    @lru_cache(maxsize=1)
    def _model(self):
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise RuntimeError(
                "Install the optional 'embeddings' dependency group to enable BERT embeddings"
            ) from exc
        return SentenceTransformer(self.model_name)

    async def encode(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors = await asyncio.to_thread(
            self._model().encode,
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return [[float(value) for value in row] for row in vectors]

    @staticmethod
    def cosine(a: list[float], b: list[float]) -> float:
        if len(a) != len(b) or not a:
            raise ValueError("vectors must have equal non-zero dimensions")
        dot = sum(x * y for x, y in zip(a, b, strict=True))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(y * y for y in b))
        return 0.0 if na == 0.0 or nb == 0.0 else dot / (na * nb)
