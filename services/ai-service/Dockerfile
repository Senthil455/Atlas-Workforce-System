FROM python:3.12-slim

WORKDIR /app

COPY services/atlas_observability/ ./services/atlas_observability/
RUN pip install -e ./services/atlas_observability
COPY services/ai-service/requirements.txt .
RUN grep -v "atlas_observability" requirements.txt > req_clean.txt && \
    pip install --no-cache-dir -r req_clean.txt

COPY services/ai-service/ .

# Run as non-root to match k8s runAsUser 1001 (runAsNonRoot).
RUN groupadd -r -g 1001 appgroup && \
    useradd -r -u 1001 -g appgroup -m -d /home/appuser appuser && \
    chown -R appuser:appgroup /app /home/appuser

ENV PORT=8065

USER appuser

CMD uvicorn main:app --host 0.0.0.0 --port $PORT
