# SPHEREx blink backend (FastAPI) — production image.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SPHEREX_CACHE=/data/cache

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN useradd --system --uid 1001 spherex && mkdir -p /data/cache && chown -R spherex /data
USER spherex

EXPOSE 8000
# One worker on purpose: jobs live in process memory (JOBS dict), so requests must hit the same process.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
