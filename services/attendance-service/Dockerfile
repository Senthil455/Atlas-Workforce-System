FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o attendance-service

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/attendance-service .

# Run as non-root to match k8s runAsUser 1001 (runAsNonRoot).
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -u 1001 -G appgroup -h /home/appuser appuser && \
    chown -R appuser:appgroup /app /home/appuser

EXPOSE 8005

USER appuser

CMD ["./attendance-service"]
