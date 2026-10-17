package handlers

import (
	"os"
	"testing"

	"github.com/atlas-workforce/lms-service/models"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/google/uuid"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// These tests need a real Postgres instance because the state transitions
// fetch the enrollment (or assessment attempt) row before deciding whether the
// caller owns it. Point TEST_DATABASE_URL at a scratch database to run them;
// CI has no database, so they skip there.
const authzDBTenant = "tenant-authz-db"

func authzTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set; skipping database-backed authorization test")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger:                 logger.Default.LogMode(logger.Silent),
		SkipDefaultTransaction: true,
	})
	if err != nil {
		t.Fatalf("failed to connect to TEST_DATABASE_URL: %v", err)
	}
	if err := db.AutoMigrate(&models.Course{}, &models.Enrollment{}); err != nil {
		t.Fatalf("failed to migrate test schema: %v", err)
	}
	t.Cleanup(func() {
		db.Where("tenant_id = ?", authzDBTenant).Delete(&models.Enrollment{})
		db.Where("tenant_id = ?", authzDBTenant).Delete(&models.Course{})
	})
	return db
}

func authzEnrollmentApp(role, userID string, h *EnrollmentHandler) *fiber.App {
	app := fiber.New()
	app.Use(recover.New())
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("tenant_id", authzDBTenant)
		c.Locals("user_role", role)
		c.Locals("user_id", userID)
		return c.Next()
	})
	app.Put("/enrollments/:id/progress", h.UpdateProgress)
	app.Put("/enrollments/:id/complete", h.Complete)
	app.Delete("/enrollments/:id", h.Drop)
	return app
}

func seedEnrollment(t *testing.T, db *gorm.DB, courseID, employeeID string) models.Enrollment {
	t.Helper()
	enrollment := models.Enrollment{
		ID:         uuid.New().String(),
		TenantID:   authzDBTenant,
		CourseID:   courseID,
		EmployeeID: employeeID,
		Status:     "ENROLLED",
	}
	if err := db.Create(&enrollment).Error; err != nil {
		t.Fatalf("failed to seed enrollment: %v", err)
	}
	return enrollment
}

// TestEnrollmentStateTransitionAuthorization exercises the ownership gate on
// the three enrollment state transitions against a real database row: only the
// employee the enrollment belongs to (or an admin) may drive it.
func TestEnrollmentStateTransitionAuthorization(t *testing.T) {
	db := authzTestDB(t)
	h := &EnrollmentHandler{DB: db}

	course := models.Course{
		ID:                     uuid.New().String(),
		TenantID:               authzDBTenant,
		Title:                  "Authorization Test Course",
		Status:                 "PUBLISHED",
		CompletionThresholdPct: 0,
	}
	if err := db.Create(&course).Error; err != nil {
		t.Fatalf("failed to seed course: %v", err)
	}

	cases := []struct {
		name     string
		role     string
		userID   string
		route    string
		owner    string
		body     string
		wantCode int
	}{
		{"owner can update progress", "employee", "emp-owner", "progress", "emp-owner", `{"progress_pct":50}`, fiber.StatusOK},
		{"peer cannot update progress", "employee", "emp-peer", "progress", "emp-other", `{"progress_pct":50}`, fiber.StatusForbidden},
		{"admin can update progress for anyone", "admin", "emp-admin", "progress", "emp-other", `{"progress_pct":50}`, fiber.StatusOK},
		{"owner can complete", "employee", "emp-owner", "complete", "emp-owner", "", fiber.StatusOK},
		{"peer cannot complete", "employee", "emp-peer", "complete", "emp-other", "", fiber.StatusForbidden},
		{"admin can complete for anyone", "admin", "emp-admin", "complete", "emp-other", "", fiber.StatusOK},
		{"owner can drop", "employee", "emp-owner", "drop", "emp-owner", "", fiber.StatusOK},
		{"peer cannot drop", "employee", "emp-peer", "drop", "emp-other", "", fiber.StatusForbidden},
		{"admin can drop for anyone", "admin", "emp-admin", "drop", "emp-other", "", fiber.StatusOK},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			enrollment := seedEnrollment(t, db, course.ID, tc.owner+"-"+uuid.New().String()[:8])
			app := authzEnrollmentApp(tc.role, tc.userID, h)

			var method, path string
			switch tc.route {
			case "progress":
				method, path = "PUT", "/enrollments/"+enrollment.ID+"/progress"
			case "complete":
				method, path = "PUT", "/enrollments/"+enrollment.ID+"/complete"
			case "drop":
				method, path = "DELETE", "/enrollments/"+enrollment.ID
			}

			if got := authzStatus(t, app, method, path, tc.body); got != tc.wantCode {
				t.Errorf("expected %d, got %d", tc.wantCode, got)
			}

			// A denied transition must not have touched the row.
			if tc.wantCode == fiber.StatusForbidden {
				var reloaded models.Enrollment
				if err := db.Where("id = ?", enrollment.ID).First(&reloaded).Error; err != nil {
					t.Fatalf("failed to reload enrollment: %v", err)
				}
				if reloaded.Status != "ENROLLED" {
					t.Errorf("denied request mutated enrollment status to %q", reloaded.Status)
				}
			}
		})
	}
}
