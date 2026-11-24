# Stage 1: Build dependencies
FROM python:3.12-alpine AS builder
WORKDIR /app
RUN apk add --no-cache gcc musl-dev libffi-dev
COPY services/employee-python-service/requirements.txt .
RUN pip install --no-cache-dir --user --ignore-installed typing_extensions>=4.8.0 && \
    grep -v "atlas_observability" requirements.txt > req_clean.txt && \
    pip install --no-cache-dir --user --ignore-installed -r req_clean.txt
COPY services/atlas_observability/ ./services/atlas_observability/
RUN pip install --no-cache-dir --user --no-deps -e ./services/atlas_observability && \
    pip install --no-cache-dir --user prometheus-client>=0.19.0

FROM python:3.12-alpine
WORKDIR /app
COPY --from=builder /root/.local /root/.local
COPY --from=builder /app/services/atlas_observability /app/services/atlas_observability
COPY services/employee-python-service/ .
ENV PATH=/home/appuser/.local/bin:$PATH
ENV HOME=/home/appuser

# Run as non-root to match k8s runAsUser 1001 (runAsNonRoot).
# Installed wheels live in /root/.local, so copy them to the app user home.
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -u 1001 -G appgroup -h /home/appuser appuser && \
    cp -r /root/.local /home/appuser/.local && \
    chown -R appuser:appgroup /home/appuser /app

EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=4).status == 200 else 1)"

USER appuser

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
