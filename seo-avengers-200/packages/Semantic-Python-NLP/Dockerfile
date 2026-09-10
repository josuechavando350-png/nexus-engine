FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN python -m pip install --upgrade pip && \
    python -m pip install \
      "fastapi>=0.116,<1" \
      "uvicorn[standard]>=0.35,<1" \
      "pydantic>=2.11,<3" \
      "httpx>=0.28,<1" \
      "beautifulsoup4>=4.13,<5" \
      "google-cloud-language>=2.17,<3" \
      "redis>=6,<7"

COPY main.py bert_embeddings.py ./

EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
