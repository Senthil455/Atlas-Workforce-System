# ── Builder stage ──────────────────────────────
FROM python:3.10-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc build-essential && \
    rm -rf /var/lib/apt/lists/*

COPY services/atlas_observability/ ./services/atlas_observability/
RUN pip install -e ./services/atlas_observability
COPY services/ai-copilot-service/requirements.txt .
RUN grep -v "atlas_observability" requirements.txt > req_clean.txt && \
    pip wheel --no-cache-dir --no-deps --wheel-dir /app/wheels -r req_clean.txt

# ── Runtime stage ─────────────────────────────
FROM python:3.10-slim AS runtime

WORKDIR /app

# Create non-root user with the fixed k8s UID/GID (runAsUser 1001)
RUN groupadd -r -g 1001 appgroup && \
    useradd -r -u 1001 -g appgroup -m -d /home/appuser appuser && \
    chown -R appuser:appgroup /app /home/appuser

# Copy Python wheels from builder
COPY --from=builder /app/wheels /wheels
COPY --from=builder /app/requirements.txt .
RUN pip install --no-cache-dir /wheels/*

# Copy observability package source and install
COPY --from=builder /app/services/atlas_observability /app/services/atlas_observability
RUN pip install -e ./services/atlas_observability

# Copy application code
COPY services/ai-copilot-service/ .

# App files were copied as root after user creation, so fix ownership.
RUN chown -R appuser:appgroup /app

# Switch to non-root user (uid 1001, matches k8s runAsUser)
USER appuser

EXPOSE 8015

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8015"]
