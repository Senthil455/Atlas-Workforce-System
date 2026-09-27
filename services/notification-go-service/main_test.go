package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestValidateJWT_NoSecret(t *testing.T) {
	os.Unsetenv("JWT_SECRET")
	_, err := validateJWT("some-token")
	if err == nil {
		t.Error("expected error when JWT_SECRET is not set")
	}
}

func TestValidateJWT_InvalidToken(t *testing.T) {
	os.Setenv("JWT_SECRET", "test-secret")
	defer os.Unsetenv("JWT_SECRET")
	_, err := validateJWT("invalid-token")
	if err == nil {
		t.Error("expected error for invalid token")
	}
}

func TestValidateJWT_ValidToken(t *testing.T) {
	os.Setenv("JWT_SECRET", "test-secret")
	defer os.Unsetenv("JWT_SECRET")

	claims := jwt.MapClaims{
		"sub":       "user-123",
		"tenant_id": "test-tenant",
		"exp":       time.Now().Add(time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString([]byte("test-secret"))
	if err != nil {
		t.Fatalf("failed to sign token: %v", err)
	}

	parsedClaims, err := validateJWT(tokenString)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if parsedClaims.TenantID != "test-tenant" {
		t.Errorf("expected tenant_id=test-tenant, got %s", parsedClaims.TenantID)
	}
}

func TestValidateJWT_ExpiredToken(t *testing.T) {
	os.Setenv("JWT_SECRET", "test-secret")
	defer os.Unsetenv("JWT_SECRET")

	claims := jwt.MapClaims{
		"sub":       "user-123",
		"tenant_id": "test-tenant",
		"exp":       time.Now().Add(-time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, _ := token.SignedString([]byte("test-secret"))

	_, err := validateJWT(tokenString)
	if err == nil {
		t.Error("expected error for expired token")
	}
}

func TestValidateJWT_WrongSigningMethod(t *testing.T) {
	os.Setenv("JWT_SECRET", "test-secret")
	defer os.Unsetenv("JWT_SECRET")

	claims := jwt.MapClaims{
		"sub":       "user-123",
		"tenant_id": "test-tenant",
		"exp":       time.Now().Add(time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodNone, claims)
	tokenString, _ := token.SignedString(jwt.UnsafeAllowNoneSignatureType)

	_, err := validateJWT(tokenString)
	if err == nil {
		t.Error("expected error for none signing method")
	}
}

func TestNotificationStore_Add(t *testing.T) {
	store := &NotificationStore{}
	n := Notification{
		ID:        "notif-1",
		Title:     "Test",
		Message:   "Test message",
		TenantID:  "tenant-1",
		Read:      false,
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	store.Add(n)
	items := store.List("")
	if len(items) != 1 {
		t.Errorf("expected 1 item, got %d", len(items))
	}
	if items[0].ID != "notif-1" {
		t.Errorf("expected notif-1, got %s", items[0].ID)
	}
}

func TestNotificationStore_ListByTenant(t *testing.T) {
	store := &NotificationStore{}
	store.Add(Notification{ID: "1", TenantID: "tenant-a"})
	store.Add(Notification{ID: "2", TenantID: "tenant-b"})
	store.Add(Notification{ID: "3", TenantID: "tenant-a"})

	items := store.List("tenant-a")
	if len(items) != 2 {
		t.Errorf("expected 2 items for tenant-a, got %d", len(items))
	}

	items = store.List("tenant-b")
	if len(items) != 1 {
		t.Errorf("expected 1 item for tenant-b, got %d", len(items))
	}
}

func TestNotificationStore_MarkRead(t *testing.T) {
	store := &NotificationStore{}
	store.Add(Notification{ID: "1", TenantID: "tenant-a", Read: false})
	store.Add(Notification{ID: "2", TenantID: "tenant-a", Read: false})

	store.MarkRead([]string{"1"})

	items := store.List("tenant-a")
	for _, item := range items {
		if item.ID == "1" && !item.Read {
			t.Error("expected item 1 to be marked as read")
		}
		if item.ID == "2" && item.Read {
			t.Error("expected item 2 to remain unread")
		}
	}
}

func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	healthHandler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var result map[string]string
	json.NewDecoder(w.Body).Decode(&result)
	if result["status"] != "Notification Service is running" {
		t.Errorf("unexpected status: %s", result["status"])
	}
}

func TestHandleConnections_MissingToken(t *testing.T) {
	req := httptest.NewRequest("GET", "/ws", nil)
	w := httptest.NewRecorder()
	handleConnections(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestHandleConnections_InvalidToken(t *testing.T) {
	req := httptest.NewRequest("GET", "/ws?token=invalid", nil)
	w := httptest.NewRecorder()
	handleConnections(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestListNotificationsHandler_MissingTenant(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/notifications", nil)
	w := httptest.NewRecorder()
	listNotificationsHandler(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestListNotificationsHandler_WithTenant(t *testing.T) {
	store.Add(Notification{
		ID:        "notif-1",
		Title:     "Test",
		Message:   "Test message",
		TenantID:  "tenant-1",
		Read:      false,
		CreatedAt: time.Now().Format(time.RFC3339),
	})

	req := httptest.NewRequest("GET", "/api/notifications", nil)
	req.Header.Set("X-Tenant-Id", "tenant-1")
	w := httptest.NewRecorder()
	listNotificationsHandler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	var result []Notification
	json.NewDecoder(w.Body).Decode(&result)
	if len(result) != 1 {
		t.Errorf("expected 1 notification, got %d", len(result))
	}
}

func TestMarkReadHandler_InvalidBody(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/notifications", bytes.NewBufferString("invalid json"))
	w := httptest.NewRecorder()
	markReadHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestMarkReadHandler_EmptyIDs(t *testing.T) {
	body := `{"ids": []}`
	req := httptest.NewRequest("POST", "/api/notifications", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	markReadHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestMarkReadHandler_Success(t *testing.T) {
	store.Add(Notification{
		ID:        "notif-2",
		Title:     "Test",
		Message:   "Test message",
		TenantID:  "tenant-2",
		Read:      false,
		CreatedAt: time.Now().Format(time.RFC3339),
	})

	body := `{"ids": ["notif-2"]}`
	req := httptest.NewRequest("POST", "/api/notifications", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	markReadHandler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestInternalAuthMiddleware_NoSecret(t *testing.T) {
	os.Unsetenv("INTERNAL_JWT_SECRET")

	handler := internalAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/notifications", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}

func TestInternalAuthMiddleware_MissingToken(t *testing.T) {
	os.Setenv("INTERNAL_JWT_SECRET", "test-secret")
	defer os.Unsetenv("INTERNAL_JWT_SECRET")

	handler := internalAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/notifications", nil)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestInternalAuthMiddleware_InvalidToken(t *testing.T) {
	os.Setenv("INTERNAL_JWT_SECRET", "test-secret")
	defer os.Unsetenv("INTERNAL_JWT_SECRET")

	handler := internalAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/notifications", nil)
	req.Header.Set("x-internal-auth", "invalid-token")
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestCanAcceptConnection(t *testing.T) {
	ipConnections = make(map[string]int)

	if !canAcceptConnection("192.168.1.1") {
		t.Error("expected true for new connection")
	}

	ipConnections["192.168.1.1"] = maxConnsPerIP
	if canAcceptConnection("192.168.1.1") {
		t.Error("expected false when at max connections")
	}
}

func TestReleaseConnection(t *testing.T) {
	ipConnections = make(map[string]int)
	ipConnections["192.168.1.1"] = 5

	releaseConnection("192.168.1.1")
	if ipConnections["192.168.1.1"] != 4 {
		t.Errorf("expected 4, got %d", ipConnections["192.168.1.1"])
	}

	ipConnections["192.168.1.1"] = 1
	releaseConnection("192.168.1.1")
	if _, ok := ipConnections["192.168.1.1"]; ok {
		t.Error("expected key to be deleted at 0")
	}
}

func TestNotificationStore_ListEmpty(t *testing.T) {
	store := &NotificationStore{}
	items := store.List("")
	if len(items) != 0 {
		t.Errorf("expected 0 items, got %d", len(items))
	}
}

func TestNotificationStore_ListNonExistentTenant(t *testing.T) {
	store := &NotificationStore{}
	store.Add(Notification{ID: "1", TenantID: "tenant-a"})
	items := store.List("nonexistent")
	if len(items) != 0 {
		t.Errorf("expected 0 items, got %d", len(items))
	}
}

func TestNotificationStore_MarkReadNonExistent(t *testing.T) {
	store := &NotificationStore{}
	store.Add(Notification{ID: "1", TenantID: "tenant-a", Read: false})
	store.MarkRead([]string{"nonexistent"})
	items := store.List("tenant-a")
	if len(items) != 1 {
		t.Errorf("expected 1 item, got %d", len(items))
	}
	if items[0].Read {
		t.Error("expected item to remain unread")
	}
}

func TestInternalAuthMiddleware_ValidToken(t *testing.T) {
	os.Setenv("INTERNAL_JWT_SECRET", "test-secret")
	defer os.Unsetenv("INTERNAL_JWT_SECRET")

	claims := jwt.MapClaims{
		"sub":       "user-123",
		"tenant_id": "test-tenant",
		"exp":       time.Now().Add(time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, _ := token.SignedString([]byte("test-secret"))

	handler := internalAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/notifications", nil)
	req.Header.Set("x-internal-auth", tokenString)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestInternalAuthMiddleware_ExpiredToken(t *testing.T) {
	os.Setenv("INTERNAL_JWT_SECRET", "test-secret")
	defer os.Unsetenv("INTERNAL_JWT_SECRET")

	claims := jwt.MapClaims{
		"sub":       "user-123",
		"tenant_id": "test-tenant",
		"exp":       time.Now().Add(-time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, _ := token.SignedString([]byte("test-secret"))

	handler := internalAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/notifications", nil)
	req.Header.Set("x-internal-auth", tokenString)
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}
