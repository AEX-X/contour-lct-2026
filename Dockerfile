FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY alembic ./alembic
COPY alembic.ini ./alembic.ini
COPY pytest.ini ./pytest.ini
COPY tests ./tests
COPY data ./data
COPY scripts/concurrency-smoke.py ./scripts/concurrency-smoke.py
COPY scripts/check-risk-provenance.py ./scripts/check-risk-provenance.py
# ML model-quality metrics: fallback for /api/v1/model-quality when the ML service is not running.
COPY ml/outputs/ml-baseline-v2/validate-stability.json ./ml/outputs/ml-baseline-v2/validate-stability.json

EXPOSE 8000

# --proxy-headers: the real client IP comes from the TLS proxy (X-Forwarded-For is set, not appended, by nginx).
# Trusting any forwarder is safe only because this port is not published outside the compose network.
CMD ["sh", "-c", "alembic upgrade head && uvicorn src.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'"]
