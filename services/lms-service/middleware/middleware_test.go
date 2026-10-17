package middleware

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

func signTestToken(t *testing.T, secret string, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("failed to sign token: %v", err)
	}
	return signed
}

func baseClaims() jwt.MapClaims {
	return jwt.MapClaims{
		"user_id":   "user-1",
		"user_role": "employee",
		"tenant_id": "tenant-1",
		"exp":       time.Now().Add(time.Hour).Unix(),
	}
}

func TestAuthMiddleware_FailsClosed(t *testing.T) {
	os.Setenv("INTERNAL_JWT_SECRET", "test-secret")
	defer os.Unsetenv("INTERNAL_JWT_SECRET")
	InitAuth()

	app := fiber.New()
	app.Use(AuthMiddleware())
	app.Get("/probe", func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusOK) })

	cases := []struct {
		name   string
		claims jwt.MapClaims
		with   bool
		want   int
	}{
		{name: "missing token", with: false, want: fiber.StatusUnauthorized},
		{
			name: "missing tenant claim",
			claims: jwt.MapClaims{
				"user_id":   "user-1",
				"user_role": "employee",
				"exp":       time.Now().Add(time.Hour).Unix(),
			},
			with: true,
			want: fiber.StatusUnauthorized,
		},
		{
			name: "missing role claim",
			claims: jwt.MapClaims{
				"user_id":   "user-1",
				"tenant_id": "tenant-1",
				"exp":       time.Now().Add(time.Hour).Unix(),
			},
			with: true,
			want: fiber.StatusForbidden,
		},
		{name: "valid claims", claims: baseClaims(), with: true, want: fiber.StatusOK},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/probe", nil)
			if tc.with {
				req.Header.Set("x-internal-auth", signTestToken(t, "test-secret", tc.claims))
			}
			resp, err := app.Test(req)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if resp.StatusCode != tc.want {
				t.Errorf("expected %d, got %d", tc.want, resp.StatusCode)
			}
		})
	}
}

func TestTenantMiddleware_FailsClosed(t *testing.T) {
	app := fiber.New()
	app.Use(TenantMiddleware())
	app.Get("/probe", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"tenant": GetTenant(c)})
	})

	req := httptest.NewRequest("GET", "/probe", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != fiber.StatusUnauthorized {
		t.Errorf("expected 401 without tenant context, got %d", resp.StatusCode)
	}

	req = httptest.NewRequest("GET", "/probe", nil)
	req.Header.Set("X-Tenant-ID", "tenant-9")
	resp, err = app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("expected 200 with header tenant, got %d", resp.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if body["tenant"] != "tenant-9" {
		t.Errorf("expected tenant-9, got %q", body["tenant"])
	}
}

func TestTenantMiddleware_UsesAuthenticatedLocals(t *testing.T) {
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("tenant_id", "tenant-from-claims")
		return c.Next()
	})
	app.Use(TenantMiddleware())
	app.Get("/probe", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"tenant": GetTenant(c)})
	})

	req := httptest.NewRequest("GET", "/probe", nil)
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if body["tenant"] != "tenant-from-claims" {
		t.Errorf("expected tenant-from-claims, got %q", body["tenant"])
	}
}

func TestAuthorizationHelpers(t *testing.T) {
	cases := []struct {
		name       string
		role       string
		userID     string
		wantAdmin  bool
		wantManage bool
		wantOwns   bool
	}{
		{"admin is admin", RoleAdmin, "user-2", true, true, true},
		{"instructor manages content but not others records", RoleInstructor, "user-2", false, true, false},
		{"employee cannot manage content", "employee", "user-2", false, false, false},
		{"employee owns own record", "employee", "emp-owner", false, false, true},
		{"missing role is unauthorized", "", "user-2", false, false, false},
		{"missing identity owns nothing", "employee", "", false, false, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New()
			app.Get("/probe", func(c *fiber.Ctx) error {
				c.Locals("user_role", tc.role)
				c.Locals("user_id", tc.userID)
				return c.JSON(fiber.Map{
					"isAdmin":     IsAdmin(c),
					"canManage":   CanManageContent(c),
					"ownsOrAdmin": OwnsOrAdmin(c, "emp-owner"),
				})
			})

			req := httptest.NewRequest("GET", "/probe", nil)
			resp, err := app.Test(req)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			var body map[string]bool
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("failed to decode response: %v", err)
			}
			if body["isAdmin"] != tc.wantAdmin {
				t.Errorf("IsAdmin: expected %v, got %v", tc.wantAdmin, body["isAdmin"])
			}
			if body["canManage"] != tc.wantManage {
				t.Errorf("CanManageContent: expected %v, got %v", tc.wantManage, body["canManage"])
			}
			if body["ownsOrAdmin"] != tc.wantOwns {
				t.Errorf("OwnsOrAdmin: expected %v, got %v", tc.wantOwns, body["ownsOrAdmin"])
			}
		})
	}
}
