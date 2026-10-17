package middleware

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

func InitAuth() {
	secret := os.Getenv("INTERNAL_JWT_SECRET")
	if secret == "" {
		panic("FATAL: INTERNAL_JWT_SECRET environment variable is required")
	}
	internalJWTSecret = []byte(secret)
}

func AuthMiddleware() fiber.Handler {
	return func(c *fiber.Ctx) error {
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

		// Fail closed: a token without tenant or role claims does not get to
		// act as a plausible default identity. Missing tenant means the
		// caller cannot be placed in any tenant (401); a tenant-bound caller
		// without a role cannot be authorized (403).
		if claims.TenantID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Missing tenant claim"})
		}
		if claims.UserRole == "" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Missing role claim"})
		}

		c.Locals("user_id", claims.UserID)
		c.Locals("user_role", claims.UserRole)
		c.Locals("tenant_id", claims.TenantID)

		return c.Next()
	}
}
