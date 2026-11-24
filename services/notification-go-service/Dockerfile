FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go build -o notification-service

FROM alpine:3.22
WORKDIR /app
COPY --from=builder /app/notification-service .

# Run as non-root to match k8s runAsUser 1001 (runAsNonRoot).
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -u 1001 -G appgroup -h /home/appuser appuser && \
    chown -R appuser:appgroup /app /home/appuser

EXPOSE 8004
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8004/health >/dev/null || exit 1

USER appuser

CMD ["./notification-service"]
