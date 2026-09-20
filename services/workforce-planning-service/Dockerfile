FROM python:3.10-alpine AS builder
WORKDIR /app
RUN apk add --no-cache gcc musl-dev libffi-dev postgresql-dev
COPY services/atlas_observability/ ./services/atlas_observability/
RUN pip install -e ./services/atlas_observability
COPY services/workforce-planning-service/requirements.txt .
RUN grep -v "atlas_observability" requirements.txt > req_clean.txt && \
    pip install --user --no-cache-dir -r req_clean.txt

FROM python:3.10-alpine
WORKDIR /app
COPY --from=builder /root/.local /root/.local
COPY services/workforce-planning-service/ .
ENV PATH=/root/.local/bin:$PATH
EXPOSE 8017
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8017"]
