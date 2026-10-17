package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/streadway/amqp"
)

func getDurationEnv(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
		log.Printf("Warning: invalid %s %q, using %s", key, v, fallback)
	}
	return fallback
}

func wsPingInterval() time.Duration {
	return getDurationEnv("WS_PING_INTERVAL_SEC", 20*time.Second)
}

func wsWriteTimeout() time.Duration {
	return getDurationEnv("WS_WRITE_TIMEOUT_SEC", 10*time.Second)
}

func wsReadTimeout() time.Duration {
	return getDurationEnv("WS_READ_TIMEOUT_SEC", 30*time.Second)
}

var (
	httpRequestCount = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "atlas_http_requests_total",
			Help: "Total HTTP requests",
		},
		[]string{"method", "path", "status_code"},
	)
	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "atlas_http_request_duration_seconds",
			Help:    "HTTP request duration in seconds",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0},
		},
		[]string{"method", "path", "status_code"},
	)
	httpRequestsInProgress = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "atlas_http_requests_in_progress",
			Help: "Number of HTTP requests in progress",
		},
		[]string{"method", "path"},
	)
	pathParamPattern = regexp.MustCompile(`/[0-9a-fA-F-]{36}|/\d+`)
)

func init() {
	prometheus.MustRegister(httpRequestCount)
	prometheus.MustRegister(httpRequestDuration)
	prometheus.MustRegister(httpRequestsInProgress)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return false
		}
		allowedOrigins := os.Getenv("ALLOWED_ORIGINS")
		if allowedOrigins == "" {
			return false
		}
		for _, o := range strings.Split(allowedOrigins, ",") {
			if strings.TrimSpace(o) == origin {
				return true
			}
		}
		return false
	},
}

// Notification represents a persisted notification
type Notification struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Message   string `json:"message"`
	TenantID  string `json:"tenant_id"`
	Read      bool   `json:"read"`
	CreatedAt string `json:"created_at"`
}

// Client represents a connected WebSocket client
type Client struct {
	conn     *websocket.Conn
	send     chan []byte
	tenantID string
	clientIP string
}

type BroadcastMessage struct {
	TenantID string
	Payload  []byte
}

// In-memory notification store
type NotificationStore struct {
	mu    sync.RWMutex
	items []Notification
}

func (s *NotificationStore) Add(n Notification) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = append([]Notification{n}, s.items...)
	if len(s.items) > 1000 {
		s.items = s.items[:1000]
	}
}

func (s *NotificationStore) List(tenantID string) []Notification {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if tenantID == "" {
		result := make([]Notification, len(s.items))
		copy(result, s.items)
		return result
	}
	result := []Notification{}
	for _, n := range s.items {
		if n.TenantID == tenantID {
			result = append(result, n)
		}
	}
	return result
}

// MarkRead marks the given ids as read only when they belong to tenantID.
// Ids that do not exist, or exist for another tenant, are left untouched.
// It returns the number of notifications actually updated.
func (s *NotificationStore) MarkRead(tenantID string, ids []string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	idSet := make(map[string]bool, len(ids))
	for _, id := range ids {
		idSet[id] = true
	}
	updated := 0
	for i := range s.items {
		if s.items[i].TenantID != tenantID {
			continue
		}
		if idSet[s.items[i].ID] && !s.items[i].Read {
			s.items[i].Read = true
			updated++
		}
	}
	return updated
}

const maxClients = 1000
const maxConnsPerIP = 10

var (
	store         = &NotificationStore{}
	clients       = make(map[*Client]bool)
	broadcast     = make(chan BroadcastMessage, 256)
	mutex         = &sync.Mutex{}
	ipConnections = make(map[string]int)
	ipMutex       = &sync.Mutex{}
)

type wsClaims struct {
	jwt.RegisteredClaims
	TenantID string `json:"tenant_id"`
}

type internalAuthClaims struct {
	jwt.RegisteredClaims
	TenantID string `json:"tenant_id"`
}

func validateJWT(tokenString string) (*wsClaims, error) {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		return nil, fmt.Errorf("JWT_SECRET not configured")
	}
	token, err := jwt.ParseWithClaims(tokenString, &wsClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*wsClaims)
	if !ok {
		return nil, fmt.Errorf("invalid token claims")
	}
	if claims.ExpiresAt != nil && claims.ExpiresAt.Time.Before(time.Now()) {
		return nil, fmt.Errorf("token has expired")
	}
	return claims, nil
}

func internalAuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		internalKey := os.Getenv("INTERNAL_JWT_SECRET")
		if internalKey == "" {
			http.Error(w, `{"error":"Service not configured"}`, http.StatusInternalServerError)
			return
		}

		internalToken := r.Header.Get("x-internal-auth")
		if internalToken == "" {
			http.Error(w, `{"error":"Missing internal authentication"}`, http.StatusUnauthorized)
			return
		}

		token, err := jwt.ParseWithClaims(internalToken, &internalAuthClaims{}, func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return []byte(internalKey), nil
		})

		if err != nil {
			http.Error(w, `{"error":"Invalid internal authentication"}`, http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(*internalAuthClaims)
		if !ok {
			http.Error(w, `{"error":"Invalid token claims"}`, http.StatusUnauthorized)
			return
		}

		if claims.ExpiresAt != nil && claims.ExpiresAt.Time.Before(time.Now()) {
			http.Error(w, `{"error":"Token has expired"}`, http.StatusUnauthorized)
			return
		}

		if claims.TenantID != "" {
			r.Header.Set("X-Tenant-Id", claims.TenantID)
		}

		next(w, r)
	}
}

func (c *Client) writePump() {
	pingInterval := wsPingInterval()
	writeTimeout := wsWriteTimeout()
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				log.Printf("WebSocket write error for tenant %s: %v", c.tenantID, err)
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("WebSocket ping error for tenant %s: %v", c.tenantID, err)
				return
			}
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		mutex.Lock()
		delete(clients, c)
		close(c.send)
		mutex.Unlock()
		releaseConnection(c.clientIP)
		_ = c.conn.Close()
	}()

	readTimeout := wsReadTimeout()
	_ = c.conn.SetReadDeadline(time.Now().Add(readTimeout))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(readTimeout))
		return nil
	})

	for {
		_, _, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived) {
				log.Printf("WebSocket closed for tenant %s: %v", c.tenantID, err)
			} else if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket unexpected close for tenant %s: %v", c.tenantID, err)
			} else {
				log.Printf("WebSocket read error for tenant %s: %v", c.tenantID, err)
			}
			break
		}
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "Notification Service is running"}); err != nil {
		log.Printf("Failed to encode health response")
	}
}

func canAcceptConnection(ip string) bool {
	ipMutex.Lock()
	defer ipMutex.Unlock()
	count := ipConnections[ip]
	if count >= maxConnsPerIP {
		return false
	}
	ipConnections[ip] = count + 1
	return true
}

func releaseConnection(ip string) {
	ipMutex.Lock()
	defer ipMutex.Unlock()
	ipConnections[ip]--
	if ipConnections[ip] <= 0 {
		delete(ipConnections, ip)
	}
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		http.Error(w, `{"error":"Missing authentication token"}`, http.StatusUnauthorized)
		return
	}

	claims, err := validateJWT(tokenStr)
	if err != nil {
		http.Error(w, `{"error":"Invalid authentication token"}`, http.StatusUnauthorized)
		return
	}

	tenantID := claims.TenantID
	if tenantID == "" {
		tenantID = "default"
	}

	clientIP := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		clientIP = host
	} else {
		log.Printf("Warning: could not split host/port from %q: %v", r.RemoteAddr, err)
		clientIP = r.RemoteAddr
	}

	if !canAcceptConnection(clientIP) {
		http.Error(w, `{"error":"Too many connections from this IP"}`, http.StatusTooManyRequests)
		return
	}

	mutex.Lock()
	if len(clients) >= maxClients {
		mutex.Unlock()
		releaseConnection(clientIP)
		http.Error(w, `{"error":"Server at maximum connection capacity"}`, http.StatusServiceUnavailable)
		return
	}
	mutex.Unlock()

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket Upgrade Error: %v", err)
		releaseConnection(clientIP)
		return
	}

	client := &Client{conn: ws, send: make(chan []byte, 256), tenantID: tenantID, clientIP: clientIP}

	mutex.Lock()
	if len(clients) >= maxClients {
		mutex.Unlock()
		_ = ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "server at capacity"))
		_ = ws.Close()
		releaseConnection(clientIP)
		log.Printf("Rejected websocket for tenant %s: at capacity after upgrade", tenantID)
		return
	}
	clients[client] = true
	mutex.Unlock()

	go client.writePump()
	client.readPump()
}

func handleMessages(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-broadcast:
			mutex.Lock()
			targets := make([]*Client, 0, len(clients))
			for client := range clients {
				if client.tenantID == msg.TenantID {
					targets = append(targets, client)
				}
			}
			mutex.Unlock()
			skipped := 0
			for _, client := range targets {
				select {
				case client.send <- msg.Payload:
				default:
					skipped++
				}
			}
			if skipped > 0 {
				log.Printf("Broadcast to tenant %s skipped %d slow clients", msg.TenantID, skipped)
			}
		}
	}
}

// REST API handlers

func listNotificationsHandler(w http.ResponseWriter, r *http.Request) {
	tenantID := r.Header.Get("X-Tenant-Id")
	if tenantID == "" {
		http.Error(w, `{"error":"Missing tenant context"}`, http.StatusForbidden)
		return
	}
	notifications := store.List(tenantID)
	page := 1
	limit := 50
	if v := r.URL.Query().Get("page"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 {
			page = p
		}
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		if l, err := strconv.Atoi(v); err == nil && l > 0 {
			limit = l
		}
	}
	if limit > 100 {
		limit = 100
	}
	start := (page - 1) * limit
	if start > len(notifications) {
		start = len(notifications)
	}
	end := start + limit
	if end > len(notifications) {
		end = len(notifications)
	}
	notifications = notifications[start:end]
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(notifications); err != nil {
		log.Printf("Failed to encode notifications response")
	}
}

// maxMarkReadIDs caps how many ids a single mark-read request may carry, so a
// hostile caller cannot force unbounded work under the store lock.
const maxMarkReadIDs = 100

func markReadHandler(w http.ResponseWriter, r *http.Request) {
	// Read state is tenant data; require the same tenant context the listing
	// handler requires so ids alone are never sufficient authority.
	tenantID := r.Header.Get("X-Tenant-Id")
	if tenantID == "" {
		http.Error(w, `{"error":"Missing tenant context"}`, http.StatusForbidden)
		return
	}

	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"Invalid request body"}`, http.StatusBadRequest)
		return
	}
	if len(req.IDs) == 0 {
		http.Error(w, `{"error":"ids array is required"}`, http.StatusBadRequest)
		return
	}
	if len(req.IDs) > maxMarkReadIDs {
		http.Error(w, `{"error":"too many ids"}`, http.StatusBadRequest)
		return
	}
	for _, id := range req.IDs {
		if _, err := uuid.Parse(id); err != nil {
			http.Error(w, `{"error":"invalid id format"}`, http.StatusBadRequest)
			return
		}
	}

	updated := store.MarkRead(tenantID, req.IDs)
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"updated": updated,
	}); err != nil {
		log.Printf("Failed to encode mark-read response")
	}
}

// sanitizeLogArg strips line breaks from externally-influenced values so a
// hostile broker message cannot forge log lines (log injection). The error
// below carries server-provided text, hence the explicit neutralization.
func sanitizeLogArg(v any) string {
	s := fmt.Sprint(v)
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	return s
}

// validPort reports whether p is a digits-only TCP port string.
func validPort(p string) bool {
	if p == "" || len(p) > 5 {
		return false
	}
	for i := 0; i < len(p); i++ {
		if p[i] < '0' || p[i] > '9' {
			return false
		}
	}
	return true
}

func setupRabbitMQConsumer(ctx context.Context) {
	rabbitURL := os.Getenv("RABBITMQ_URL")
	if rabbitURL == "" {
		log.Fatalf("FATAL: RABBITMQ_URL environment variable is required")
	}

	backoff := 1 * time.Second
	maxBackoff := 30 * time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		conn, err := amqp.Dial(rabbitURL)
		if err != nil {
			log.Printf("Failed to connect to RabbitMQ (%v), retrying in %v", err, backoff)
			time.Sleep(backoff)
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}

		backoff = 1 * time.Second

		ch, err := conn.Channel()
		if err != nil {
			log.Printf("Failed to open channel (%v), reconnecting", err)
			_ = conn.Close()
			time.Sleep(backoff)
			continue
		}

		err = ch.ExchangeDeclare("notifications_exchange", "fanout", true, false, false, false, nil)
		if err != nil {
			// #nosec G706 -- broker-provided error text is neutralized by sanitizeLogArg above
			log.Printf("Failed to declare exchange (%s), reconnecting", sanitizeLogArg(err))
			_ = ch.Close()
			_ = conn.Close()
			time.Sleep(backoff)
			continue
		}

		q, err := ch.QueueDeclare("", false, false, true, false, nil)
		if err != nil {
			log.Printf("Failed to declare queue (%v), reconnecting", err)
			_ = ch.Close()
			_ = conn.Close()
			time.Sleep(backoff)
			continue
		}

		err = ch.QueueBind(q.Name, "", "notifications_exchange", false, nil)
		if err != nil {
			log.Printf("Failed to bind queue (%v), reconnecting", err)
			_ = ch.Close()
			_ = conn.Close()
			time.Sleep(backoff)
			continue
		}

		msgs, err := ch.Consume(q.Name, "", true, false, false, false, nil)
		if err != nil {
			log.Printf("Failed to register consumer (%v), reconnecting", err)
			_ = ch.Close()
			_ = conn.Close()
			time.Sleep(backoff)
			continue
		}

		log.Println("Waiting for messages from RabbitMQ...")

	consumeLoop:
		for {
			select {
			case <-ctx.Done():
				log.Println("RabbitMQ consumer shutting down")
				_ = ch.Close()
				_ = conn.Close()
				return
			case d, ok := <-msgs:
				if !ok {
					log.Printf("RabbitMQ connection lost, reconnecting")
					_ = ch.Close()
					_ = conn.Close()
					break consumeLoop
				}
				processMessage(d.Body)
			}
		}
	}
}

func processMessage(body []byte) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Recovered from panic processing message: %v", r)
		}
	}()

	log.Printf("Received message of %d bytes", len(body))

	var rawData map[string]interface{}
	if err := json.Unmarshal(body, &rawData); err != nil {
		log.Printf("Error unmarshalling message: %v", err)
		return
	}

	tenantID := "default"
	if val, ok := rawData["tenant_id"].(string); ok {
		tenantID = val
	}

	title := "System Notification"
	if t, ok := rawData["title"].(string); ok {
		title = t
	}
	message := string(body)
	if m, ok := rawData["message"].(string); ok {
		message = m
	}

	notif := Notification{
		ID:        uuid.New().String(),
		Title:     title,
		Message:   message,
		TenantID:  tenantID,
		Read:      false,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}

	store.Add(notif)

	msgWrapper := map[string]interface{}{
		"type":      "notification",
		"data":      notif,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}
	jsonMsg, _ := json.Marshal(msgWrapper)
	log.Printf("Stored notification %s for tenant %s (%d bytes payload, %d bytes wire)", notif.ID, tenantID, len(body), len(jsonMsg))
	broadcast <- BroadcastMessage{TenantID: tenantID, Payload: jsonMsg}
}

func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" || r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		path := pathParamPattern.ReplaceAllString(r.URL.Path, "/:param")
		httpRequestsInProgress.WithLabelValues(r.Method, path).Inc()
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(sw, r)
		duration := time.Since(start).Seconds()
		httpRequestsInProgress.WithLabelValues(r.Method, path).Dec()
		httpRequestCount.WithLabelValues(r.Method, path, fmt.Sprintf("%d", sw.statusCode)).Inc()
		httpRequestDuration.WithLabelValues(r.Method, path, fmt.Sprintf("%d", sw.statusCode)).Observe(duration)
	})
}

type statusWriter struct {
	http.ResponseWriter
	statusCode int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.statusCode = code
	sw.ResponseWriter.WriteHeader(code)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		log.Fatal("FATAL: PORT environment variable is required")
	}
	if !validPort(port) {
		log.Fatal("FATAL: invalid PORT environment variable")
	}
	if os.Getenv("ALLOWED_ORIGINS") == "" {
		log.Fatal("FATAL: ALLOWED_ORIGINS environment variable is required")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go handleMessages(ctx)
	go setupRabbitMQConsumer(ctx)

	mux := http.NewServeMux()

	mux.Handle("/metrics", promhttp.Handler())

	mux.HandleFunc("/health", healthHandler)

	mux.HandleFunc("/ws", handleConnections)

	mux.HandleFunc("/api/notifications", internalAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Tenant-Id")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		switch r.Method {
		case "GET":
			listNotificationsHandler(w, r)
		case "POST":
			markReadHandler(w, r)
		default:
			http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
		}
	}))

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           metricsMiddleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigCh
		log.Println("Shutting down notification service...")
		cancel()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("HTTP server shutdown error: %v", err)
		}
	}()

	// #nosec G706 -- port is validated digits-only in main; no log forgery possible
	log.Printf("Notification Service listening on port %s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Failed to start server: %v", err)
	}
	<-ctx.Done()
}
