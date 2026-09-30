package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

func TestGetEnv(t *testing.T) {
	got := getEnv("NONEXISTENT_KEY", "default-val")
	if got != "default-val" {
		t.Errorf("expected default-val, got %s", got)
	}
}

func TestIsDuplicateKeyError(t *testing.T) {
	err := fmt.Errorf("duplicate key value violates unique constraint")
	if !isDuplicateKeyError(err) {
		t.Error("expected true for duplicate key error")
	}
}

func TestGetEnv_ExistingKey(t *testing.T) {
	os.Setenv("TEST_ENV_KEY", "test-value")
	defer os.Unsetenv("TEST_ENV_KEY")
	got := getEnv("TEST_ENV_KEY", "default-val")
	if got != "test-value" {
		t.Errorf("expected test-value, got %s", got)
	}
}

// Helper to create a test Fiber app with auth middleware
func setupTestApp() *fiber.App {
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("tenant_id", "default")
		c.Locals("user_role", "employee")
		c.Locals("user_id", "test-user")
		return c.Next()
	})
	return app
}

// Helper to generate a valid internal JWT token
func generateTestToken(secret string) string {
	claims := jwt.MapClaims{
		"user_id":   "test-user",
		"user_role": "employee",
		"tenant_id": "default",
		"exp":       time.Now().Add(time.Hour).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, _ := token.SignedString([]byte(secret))
	return tokenString
}

func TestAuthMiddleware_MissingToken(t *testing.T) {
	app := setupTestApp()
	app.Use(authMiddleware)

	req := httptest.NewRequest("GET", "/api/attendance/", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 401 {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAuthMiddleware_InvalidToken(t *testing.T) {
	app := setupTestApp()
	app.Use(authMiddleware)

	req := httptest.NewRequest("GET", "/api/attendance/", nil)
	req.Header.Set("x-internal-auth", "invalid-token")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 401 {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAuthMiddleware_ValidToken(t *testing.T) {
	os.Setenv("INTERNAL_JWT_SECRET", "test-secret")
	defer os.Unsetenv("INTERNAL_JWT_SECRET")
	initAuth()

	app := setupTestApp()
	app.Use(authMiddleware)
	app.Get("/test", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})

	token := generateTestToken("test-secret")
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("x-internal-auth", token)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestAuthMiddleware_HealthBypass(t *testing.T) {
	app := setupTestApp()
	app.Use(authMiddleware)
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})

	req := httptest.NewRequest("GET", "/health", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestClockIn_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/clock-in", clockIn)

	body := `{"employeeId": "emp-123", "localDate": "2026-09-27"}`
	req := httptest.NewRequest("POST", "/api/attendance/clock-in", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if !strings.Contains(result["status"].(string), "Mock clocked in") {
		t.Errorf("expected mock clock-in status, got %v", result["status"])
	}
}

func TestClockOut_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/clock-out", clockOut)

	body := `{"employeeId": "emp-123", "localDate": "2026-09-27"}`
	req := httptest.NewRequest("POST", "/api/attendance/clock-out", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if !strings.Contains(result["status"].(string), "Mock clocked out") {
		t.Errorf("expected mock clock-out status, got %v", result["status"])
	}
}

func TestClockIn_InvalidBody(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/clock-in", clockIn)

	req := httptest.NewRequest("POST", "/api/attendance/clock-in", bytes.NewBufferString("invalid json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 400 {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestClockIn_Remote(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/clock-in", clockIn)

	body := `{"employeeId": "emp-123", "isRemote": true}`
	req := httptest.NewRequest("POST", "/api/attendance/clock-in", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if !strings.Contains(result["status"].(string), "Mock clocked in") {
		t.Errorf("expected mock clock-in status, got %v", result["status"])
	}
}

func TestClockIn_WFH(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/clock-in", clockIn)

	body := `{"employeeId": "emp-123", "isWfh": true}`
	req := httptest.NewRequest("POST", "/api/attendance/clock-in", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestClockOut_InvalidBody(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/clock-out", clockOut)

	req := httptest.NewRequest("POST", "/api/attendance/clock-out", bytes.NewBufferString("invalid json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 400 {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestGetEmployeeAttendance_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Get("/api/attendance/employee/:employeeId", getEmployeeAttendance)

	req := httptest.NewRequest("GET", "/api/attendance/employee/emp-123", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var result []interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if result == nil {
		t.Error("expected non-nil result")
	}
}

func TestListAttendance_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Get("/api/attendance/", listAttendance)

	req := httptest.NewRequest("GET", "/api/attendance/", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var result []interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if result == nil {
		t.Error("expected non-nil result")
	}
}

func TestGetAttendance_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Get("/api/attendance/:id", getAttendance)

	req := httptest.NewRequest("GET", "/api/attendance/123", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 404 {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

func TestGetDashboardSummary_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Get("/api/attendance/dashboard/summary", getDashboardSummary)

	req := httptest.NewRequest("GET", "/api/attendance/dashboard/summary", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if result["presentToday"].(float64) != 0 {
		t.Errorf("expected 0 presentToday, got %v", result["presentToday"])
	}
}

func TestListGeoFences_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Get("/api/attendance/geo-fences", listGeoFences)

	req := httptest.NewRequest("GET", "/api/attendance/geo-fences", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestCreateShift_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/shifts", createShift)

	body := `{"name": "Morning Shift", "startTime": "09:00", "endTime": "17:00"}`
	req := httptest.NewRequest("POST", "/api/attendance/shifts", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 201 {
		t.Errorf("expected 201, got %d", resp.StatusCode)
	}
}

func TestVerifyGeoLocation_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/geo-fences/verify", verifyGeoLocation)

	body := `{"latitude": 40.7128, "longitude": -74.0060}`
	req := httptest.NewRequest("POST", "/api/attendance/geo-fences/verify", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if result["verified"] != true {
		t.Errorf("expected verified=true, got %v", result["verified"])
	}
}

func TestVerifyGeoLocation_InvalidLatitude(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/geo-fences/verify", verifyGeoLocation)

	body := `{"latitude": 999, "longitude": 0}`
	req := httptest.NewRequest("POST", "/api/attendance/geo-fences/verify", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 400 {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

func TestPredictLateArrival_MockDB(t *testing.T) {
	app := setupTestApp()
	app.Post("/api/attendance/predict/late-arrival", predictLateArrival)

	body := `{"employeeId": "emp-123"}`
	req := httptest.NewRequest("POST", "/api/attendance/predict/late-arrival", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	if result["prediction"] != false {
		t.Errorf("expected prediction=false, got %v", result["prediction"])
	}
}

func TestHaversine(t *testing.T) {
	// Same point should be 0
	dist := haversine(40.7128, -74.0060, 40.7128, -74.0060)
	if dist != 0 {
		t.Errorf("expected 0, got %f", dist)
	}

	// NYC to LA should be roughly 3935km
	dist = haversine(40.7128, -74.0060, 34.0522, -118.2437)
	if dist < 3900000 || dist > 4000000 {
		t.Errorf("expected ~3935000m, got %f", dist)
	}
}

func TestSeverityLabel(t *testing.T) {
	if severityLabel(5) != "low" {
		t.Error("expected low for 5%")
	}
	if severityLabel(15) != "medium" {
		t.Error("expected medium for 15%")
	}
	if severityLabel(50) != "high" {
		t.Error("expected high for 50%")
	}
}

func TestTrendDirection(t *testing.T) {
	if trendDirection(5) != "up" {
		t.Error("expected up for positive trend")
	}
	if trendDirection(-5) != "down" {
		t.Error("expected down for negative trend")
	}
	if trendDirection(0) != "stable" {
		t.Error("expected stable for zero trend")
	}
}
