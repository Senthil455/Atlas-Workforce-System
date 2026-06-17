package main

import (
	"os"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
)

type internalClaims struct {
	jwt.RegisteredClaims
	UserID   string `json:"user_id"`
	UserRole string `json:"user_role"`
	TenantID string `json:"tenant_id"`
}

var internalJWTSecret []byte

func initAuth() {
	secret := os.Getenv("INTERNAL_JWT_SECRET")
	if secret == "" {
		panic("FATAL: INTERNAL_JWT_SECRET environment variable is required")
	}
	internalJWTSecret = []byte(secret)
}

func authMiddleware(c *fiber.Ctx) error {
	path := c.Path()
	if path == "/health" {
		return c.Next()
	}

	internalToken := c.Get("x-internal-auth")
	if internalToken == "" {
		return c.Status(401).JSON(fiber.Map{"error": "Missing internal authentication"})
	}

	token, err := jwt.ParseWithClaims(internalToken, &internalClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fiber.NewError(401, "Invalid signing method")
		}
		return internalJWTSecret, nil
	})

	if err != nil {
		return c.Status(401).JSON(fiber.Map{"error": "Invalid internal authentication"})
	}

	claims, ok := token.Claims.(*internalClaims)
	if !ok {
		return c.Status(401).JSON(fiber.Map{"error": "Invalid token claims"})
	}

	if claims.ExpiresAt != nil && claims.ExpiresAt.Time.Before(time.Now()) {
		return c.Status(401).JSON(fiber.Map{"error": "Token has expired"})
	}

	userID := claims.UserID
	userRole := claims.UserRole
	tenantID := claims.TenantID

	if tenantID == "" {
		tenantID = "default"
	}
	if userRole == "" {
		userRole = "employee"
	}

	c.Locals("user_id", userID)
	c.Locals("user_role", userRole)
	c.Locals("tenant_id", tenantID)

	return c.Next()
}

func getTenant(c *fiber.Ctx) string {
	if v, ok := c.Locals("tenant_id").(string); ok && v != "" {
		return v
	}
	return "default"
}

func getUserRole(c *fiber.Ctx) string {
	if v, ok := c.Locals("user_role").(string); ok {
		return v
	}
	return "employee"
}

func getUserID(c *fiber.Ctx) string {
	if v, ok := c.Locals("user_id").(string); ok {
		return v
	}
	return ""
}
