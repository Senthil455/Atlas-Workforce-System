package handlers

import (
	"bytes"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/recover"
)

// authzApp builds a fiber app with the identity locals the auth middleware
// would set, so handler authorization can be exercised without a database.
// Handlers that pass their gate then meet a nil *gorm.DB and panic; the
// recover middleware turns that into a 500, which proves the gate allowed the
// request through. Denied requests must never reach the DB at all.
func authzApp(role, userID string, register func(app *fiber.App)) *fiber.App {
	app := fiber.New()
	app.Use(recover.New())
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("tenant_id", "tenant-1")
		c.Locals("user_role", role)
		c.Locals("user_id", userID)
		return c.Next()
	})
	register(app)
	return app
}

func authzStatus(t *testing.T, app *fiber.App, method, path, body string) int {
	t.Helper()
	request := httptest.NewRequest(method, path, nil)
	if body != "" {
		request = httptest.NewRequest(method, path, bytes.NewBufferString(body))
		request.Header.Set("Content-Type", "application/json")
	}
	resp, err := app.Test(request)
	if err != nil {
		t.Fatalf("app test failed: %v", err)
	}
	return resp.StatusCode
}

const (
	nilDBPanic = fiber.StatusInternalServerError // nil DB panics -> recover -> 500
	forbidden  = fiber.StatusForbidden
)

func TestMutatingHandlerAuthorization(t *testing.T) {
	courseHandler := &CourseHandler{}
	enrollmentHandler := &EnrollmentHandler{}
	certHandler := &CertificationHandler{}
	assessmentHandler := &AssessmentHandler{}

	cases := []struct {
		name     string
		role     string
		userID   string
		register func(app *fiber.App)
		method   string
		path     string
		body     string
		want     int
	}{
		// Course content: instructor/admin only.
		{"employee cannot create a course", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/courses", courseHandler.Create) },
			"POST", "/courses", `{"title":"Course"}`, forbidden},
		{"instructor passes course create to persistence", "instructor", "emp-1",
			func(a *fiber.App) { a.Post("/courses", courseHandler.Create) },
			"POST", "/courses", `{"title":"Course"}`, nilDBPanic},
		{"employee cannot update a course", "employee", "emp-1",
			func(a *fiber.App) { a.Put("/courses/:id", courseHandler.Update) },
			"PUT", "/courses/c-1", `{}`, forbidden},
		{"employee cannot delete a course", "employee", "emp-1",
			func(a *fiber.App) { a.Delete("/courses/:id", courseHandler.Delete) },
			"DELETE", "/courses/c-1", "", forbidden},
		{"employee cannot publish a course", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/courses/:id/publish", courseHandler.Publish) },
			"POST", "/courses/c-1/publish", "", forbidden},
		{"employee cannot archive a course", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/courses/:id/archive", courseHandler.Archive) },
			"POST", "/courses/c-1/archive", "", forbidden},

		// Enrollment creation: managers or the employee themselves.
		{"employee cannot enroll a colleague", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/enrollments", enrollmentHandler.Enroll) },
			"POST", "/enrollments", `{"course_id":"c-1","employee_id":"emp-2"}`, forbidden},
		{"employee may self-enroll", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/enrollments", enrollmentHandler.Enroll) },
			"POST", "/enrollments", `{"course_id":"c-1","employee_id":"emp-1"}`, nilDBPanic},
		{"instructor may enroll an employee", "instructor", "emp-1",
			func(a *fiber.App) { a.Post("/enrollments", enrollmentHandler.Enroll) },
			"POST", "/enrollments", `{"course_id":"c-1","employee_id":"emp-2"}`, nilDBPanic},
		{"employee cannot bulk enroll", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/enrollments/bulk", enrollmentHandler.BulkEnroll) },
			"POST", "/enrollments/bulk", `{"course_id":"c-1","employee_ids":["emp-2"]}`, forbidden},
		{"instructor passes bulk enroll to persistence", "instructor", "emp-1",
			func(a *fiber.App) { a.Post("/enrollments/bulk", enrollmentHandler.BulkEnroll) },
			"POST", "/enrollments/bulk", `{"course_id":"c-1","employee_ids":["emp-2"]}`, nilDBPanic},

		// Certifications: instructor/admin edit, admin-only verify.
		{"employee cannot create a certification", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/certifications", certHandler.Create) },
			"POST", "/certifications", `{"employee_id":"emp-2","name":"C"}`, forbidden},
		{"employee cannot update a certification", "employee", "emp-1",
			func(a *fiber.App) { a.Put("/certifications/:id", certHandler.Update) },
			"PUT", "/certifications/cert-1", `{}`, forbidden},
		{"employee cannot verify a certification", "employee", "emp-1",
			func(a *fiber.App) { a.Put("/certifications/:id/verify", certHandler.Verify) },
			"PUT", "/certifications/cert-1/verify", "", forbidden},
		{"instructor cannot verify a certification", "instructor", "emp-1",
			func(a *fiber.App) { a.Put("/certifications/:id/verify", certHandler.Verify) },
			"PUT", "/certifications/cert-1/verify", "", forbidden},
		{"admin passes verification to persistence", "admin", "emp-1",
			func(a *fiber.App) { a.Put("/certifications/:id/verify", certHandler.Verify) },
			"PUT", "/certifications/cert-1/verify", "", nilDBPanic},

		// Assessments: instructor/admin author, owner/admin attempts.
		{"employee cannot create an assessment", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/assessments", assessmentHandler.Create) },
			"POST", "/assessments", `{"course_id":"c-1","title":"A"}`, forbidden},
		{"employee cannot update an assessment", "employee", "emp-1",
			func(a *fiber.App) { a.Put("/assessments/:id", assessmentHandler.Update) },
			"PUT", "/assessments/a-1", `{}`, forbidden},
		{"employee cannot start another employee's attempt", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/assessments/:id/attempt", assessmentHandler.StartAttempt) },
			"POST", "/assessments/a-1/attempt", `{"employee_id":"emp-2"}`, forbidden},
		{"employee may start own attempt", "employee", "emp-1",
			func(a *fiber.App) { a.Post("/assessments/:id/attempt", assessmentHandler.StartAttempt) },
			"POST", "/assessments/a-1/attempt", `{"employee_id":"emp-1"}`, nilDBPanic},
		{"employee cannot submit another employee's attempt", "employee", "emp-1",
			func(a *fiber.App) { a.Put("/assessments/:id/attempt", assessmentHandler.SubmitAttempt) },
			"PUT", "/assessments/a-1/attempt", `{"attempt_id":"at-1","employee_id":"emp-2"}`, forbidden},
		{"employee may submit own attempt", "employee", "emp-1",
			func(a *fiber.App) { a.Put("/assessments/:id/attempt", assessmentHandler.SubmitAttempt) },
			"PUT", "/assessments/a-1/attempt", `{"attempt_id":"at-1","employee_id":"emp-1"}`, nilDBPanic},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := authzApp(tc.role, tc.userID, tc.register)
			if got := authzStatus(t, app, tc.method, tc.path, tc.body); got != tc.want {
				t.Errorf("expected %d, got %d", tc.want, got)
			}
		})
	}
}
