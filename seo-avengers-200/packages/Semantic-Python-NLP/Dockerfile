FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml ./
COPY main.py bert_embeddings.py railway_entry.py render_entry.py render_neon_entry.py neon_store.py local_semantic_provider.py site_bootstrap.py ./

RUN python -m pip install --upgrade pip && \
    python -m pip install .

EXPOSE 8080

CMD ["uvicorn", "railway_entry:app", "--host", "0.0.0.0", "--port", "8080"]
