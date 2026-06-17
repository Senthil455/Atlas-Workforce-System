package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/streadway/amqp"
)

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
			allowedOrigins = "http://localhost:3000"
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
	var result []Notification
	for _, n := range s.items {
		if n.TenantID == tenantID {
			result = append(result, n)
		}
	}
	return result
}

func (s *NotificationStore) MarkRead(ids []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	idSet := make(map[string]bool, len(ids))
	for _, id := range ids {
		idSet[id] = true
	}
	for i := range s.items {
		if idSet[s.items[i].ID] {
			s.items[i].Read = true
		}
	}
}

var (
	store     = &NotificationStore{}
	clients   = make(map[*Client]bool)
	broadcast = make(chan BroadcastMessage)
	mutex     = &sync.Mutex{}
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

		if claims.TenantID != "" {
			r.Header.Set("X-Tenant-Id", claims.TenantID)
		}

		next(w, r)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
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
		c.conn.Close()
	}()

	c.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		return nil
	})

	for {
		_, _, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "Notification Service is running"})
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

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket Upgrade Error: %v", err)
		return
	}

	client := &Client{conn: ws, send: make(chan []byte, 256), tenantID: tenantID}

	mutex.Lock()
	clients[client] = true
	mutex.Unlock()

	go client.writePump()
	client.readPump()
}

func handleMessages() {
	for {
		msg := <-broadcast
		mutex.Lock()
		for client := range clients {
			if client.tenantID == msg.TenantID {
				select {
				case client.send <- msg.Payload:
				default:
					// skip slow client
				}
			}
		}
		mutex.Unlock()
	}
}

// REST API handlers

func listNotificationsHandler(w http.ResponseWriter, r *http.Request) {
	tenantID := r.URL.Query().Get("tenant_id")
	if tenantID == "" {
		tenantID = r.Header.Get("X-Tenant-Id")
	}
	notifications := store.List(tenantID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(notifications)
}

func markReadHandler(w http.ResponseWriter, r *http.Request) {
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
	store.MarkRead(req.IDs)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func setupRabbitMQConsumer() {
	rabbitURL := os.Getenv("RABBITMQ_URL")
	if rabbitURL == "" {
		rabbitURL = "amqp://guest:guest@rabbitmq:5672/"
	}

	var conn *amqp.Connection
	var err error

	for i := 0; i < 5; i++ {
		conn, err = amqp.Dial(rabbitURL)
		if err == nil {
			break
		}
		log.Printf("Failed to connect to RabbitMQ, retrying... (%v)", err)
		time.Sleep(5 * time.Second)
	}

	if err != nil {
		log.Printf("Could not connect to RabbitMQ: %v", err)
		return
	}

	ch, err := conn.Channel()
	if err != nil {
		log.Printf("Failed to open a channel: %v", err)
		return
	}

	err = ch.ExchangeDeclare(
		"notifications_exchange",
		"fanout",
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		log.Printf("Failed to declare an exchange: %v", err)
		return
	}

	q, err := ch.QueueDeclare(
		"",    // empty name generates a unique temporary queue name
		false, // non-durable
		false, // delete when unused
		true,  // exclusive
		false, // no-wait
		nil,   // arguments
	)
	if err != nil {
		log.Printf("Failed to declare a queue: %v", err)
		return
	}

	err = ch.QueueBind(
		q.Name,
		"",
		"notifications_exchange",
		false,
		nil,
	)
	if err != nil {
		log.Printf("Failed to bind queue: %v", err)
		return
	}

	msgs, err := ch.Consume(
		q.Name,
		"",
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		log.Printf("Failed to register a consumer: %v", err)
		return
	}

	log.Println("Waiting for messages from RabbitMQ...")
	for d := range msgs {
		processMessage(d.Body)
	}
}

func processMessage(body []byte) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Recovered from panic processing message: %v", r)
		}
	}()

	log.Printf("Received a message: %s", body)

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
		"timestamp": time.Now().Format(time.RFC3339),
	}
	jsonMsg, _ := json.Marshal(msgWrapper)
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
		port = "8004"
	}

	go handleMessages()
	go setupRabbitMQConsumer()

	mux := http.NewServeMux()

	// Metrics
	mux.Handle("/metrics", promhttp.Handler())

	// Health
	mux.HandleFunc("/health", healthHandler)

	// WebSocket
	mux.HandleFunc("/ws", handleConnections)

	// REST API for notifications (requires internal auth)
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

	log.Printf("Notification Service listening on port %s", port)
	if err := http.ListenAndServe(":"+port, metricsMiddleware(mux)); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
