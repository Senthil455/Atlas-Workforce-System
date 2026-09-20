FROM python:3.12-slim
WORKDIR /app
COPY services/atlas_observability/ ./services/atlas_observability/
RUN pip install -e ./services/atlas_observability
COPY services/live-service/requirements.txt .
RUN grep -v "atlas_observability" requirements.txt > req_clean.txt && \
    pip install --no-cache-dir -r req_clean.txt
COPY services/live-service/ .
EXPOSE 8060
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8060"]
