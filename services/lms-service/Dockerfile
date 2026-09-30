FROM golang:1.21-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download 2>/dev/null || true

COPY . .

RUN go mod tidy && CGO_ENABLED=0 GOOS=linux go build -o /app/lms-service .

FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/lms-service .

# Run as non-root to match k8s runAsUser 1001 (runAsNonRoot).
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -u 1001 -G appgroup -h /home/appuser appuser && \
    chown -R appuser:appgroup /app /home/appuser

EXPOSE 8013

USER appuser

CMD ["./lms-service"]
