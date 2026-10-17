package middleware

import (
	"github.com/gofiber/fiber/v2"
)

// TenantMiddleware fails closed: a request that reaches it without an
// authenticated tenant (or an explicit X-Tenant-ID for service-to-service
// calls) is rejected instead of being silently assigned to a shared
// "default" bucket.
func TenantMiddleware() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if v, ok := c.Locals("tenant_id").(string); ok && v != "" {
			return c.Next()
		}
		tenantID := c.Get("X-Tenant-ID")
		if tenantID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "Missing tenant context",
			})
		}
		c.Locals("tenant_id", tenantID)
		return c.Next()
	}
}

// GetTenant returns the caller tenant, or "" when none was established.
// TenantMiddleware rejects such requests first, so an empty value here means a
// handler was wired without it and must not proceed.
func GetTenant(c *fiber.Ctx) string {
	if v, ok := c.Locals("tenant_id").(string); ok {
		return v
	}
	return ""
}

// GetUserRole returns the authenticated role, or "" when missing. Callers must
// treat "" as unauthorized.
func GetUserRole(c *fiber.Ctx) string {
	if v, ok := c.Locals("user_role").(string); ok {
		return v
	}
	return ""
}

// GetUserID returns the authenticated user id, or "" when missing.
func GetUserID(c *fiber.Ctx) string {
	if v, ok := c.Locals("user_id").(string); ok {
		return v
	}
	return ""
}

const (
	// RoleAdmin can manage all tenant content and verify certifications.
	RoleAdmin = "admin"
	// RoleInstructor can manage course, assessment and certification content.
	RoleInstructor = "instructor"
)

// IsAdmin reports whether the caller holds the admin role.
func IsAdmin(c *fiber.Ctx) bool {
	return GetUserRole(c) == RoleAdmin
}

// CanManageContent reports whether the caller may create or change course,
// assessment and certification content. Instructors and admins only; every
// other role, including a missing role claim, is rejected.
func CanManageContent(c *fiber.Ctx) bool {
	role := GetUserRole(c)
	return role == RoleInstructor || role == RoleAdmin
}

// OwnsOrAdmin reports whether the caller is the record owner (matched on
// employee id) or an admin. Empty identities never match.
func OwnsOrAdmin(c *fiber.Ctx, ownerEmployeeID string) bool {
	if IsAdmin(c) {
		return true
	}
	return ownerEmployeeID != "" && GetUserID(c) == ownerEmployeeID
}

// Forbidden is the shared 403 response for failed authorization checks.
func Forbidden(c *fiber.Ctx) error {
	return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
		"error": "Insufficient permissions",
	})
}
