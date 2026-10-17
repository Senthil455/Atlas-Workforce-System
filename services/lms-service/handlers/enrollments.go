package handlers

import (
	"fmt"
	"net/http"
	"time"

	"github.com/atlas-workforce/lms-service/middleware"
	"github.com/atlas-workforce/lms-service/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type EnrollmentHandler struct {
	DB *gorm.DB
}

func (h *EnrollmentHandler) List(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	query := h.DB.Where("tenant_id = ?", tenantID)

	if employeeID := c.Query("employee_id"); employeeID != "" {
		query = query.Where("employee_id = ?", employeeID)
	}
	if courseID := c.Query("course_id"); courseID != "" {
		query = query.Where("course_id = ?", courseID)
	}
	if status := c.Query("status"); status != "" {
		query = query.Where("status = ?", status)
	}

	page := c.QueryInt("page", 1)
	pageSize := c.QueryInt("page_size", 20)
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize

	var total int64
	query.Session(&gorm.Session{}).Model(&models.Enrollment{}).Count(&total)

	var enrollments []models.Enrollment
	if err := query.Preload("Course").Order("created_at DESC").
		Offset(offset).Limit(pageSize).Find(&enrollments).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch enrollments",
		})
	}

	return c.JSON(fiber.Map{
		"data":      enrollments,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

func (h *EnrollmentHandler) Enroll(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	var req struct {
		CourseID   string     `json:"course_id"`
		EmployeeID string     `json:"employee_id"`
		Deadline   *time.Time `json:"deadline"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}
	if req.CourseID == "" || req.EmployeeID == "" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "course_id and employee_id are required",
		})
	}
	// Enrolling is a manager action (instructor/admin, consistent with the
	// bulk path) or self-service for the employee the enrollment belongs to.
	if !middleware.CanManageContent(c) && !middleware.OwnsOrAdmin(c, req.EmployeeID) {
		return middleware.Forbidden(c)
	}

	var course models.Course
	if err := h.DB.Where("id = ? AND tenant_id = ?", req.CourseID, tenantID).First(&course).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Course not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch course",
		})
	}

	var existing models.Enrollment
	result := h.DB.Where("course_id = ? AND employee_id = ? AND tenant_id = ?",
		req.CourseID, req.EmployeeID, tenantID).First(&existing)
	if result.Error == nil {
		return c.Status(http.StatusConflict).JSON(fiber.Map{
			"error": "Employee is already enrolled in this course",
		})
	}

	enrollment := models.Enrollment{
		ID:         uuid.New().String(),
		TenantID:   tenantID,
		CourseID:   req.CourseID,
		EmployeeID: req.EmployeeID,
		Status:     "ENROLLED",
		Deadline:   req.Deadline,
	}

	if err := h.DB.Create(&enrollment).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to enroll employee",
		})
	}

	return c.Status(http.StatusCreated).JSON(fiber.Map{
		"data": enrollment,
	})
}

func (h *EnrollmentHandler) UpdateProgress(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var enrollment models.Enrollment
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&enrollment).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Enrollment not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch enrollment",
		})
	}
	// State transitions belong to the employee the record is about, or to an
	// admin acting on their behalf.
	if !middleware.OwnsOrAdmin(c, enrollment.EmployeeID) {
		return middleware.Forbidden(c)
	}
	if enrollment.Status == "COMPLETED" {
		return c.Status(http.StatusConflict).JSON(fiber.Map{
			"error": "Completed enrollments cannot be updated",
		})
	}
	if enrollment.Status == "DROPPED" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Dropped enrollments cannot be updated",
		})
	}

	var req struct {
		ProgressPct float64 `json:"progress_pct"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}
	if req.ProgressPct < 0 || req.ProgressPct > 100 {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Progress must be between 0 and 100",
		})
	}
	if req.ProgressPct < enrollment.ProgressPct {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Progress cannot decrease",
		})
	}

	updates := map[string]interface{}{
		"progress_pct": req.ProgressPct,
	}
	if req.ProgressPct > 0 && enrollment.StartedAt == nil {
		now := time.Now()
		updates["started_at"] = &now
	}
	if req.ProgressPct > 0 && enrollment.Status == "ENROLLED" {
		updates["status"] = "IN_PROGRESS"
	}

	if err := h.DB.Model(&enrollment).Updates(updates).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to update progress",
		})
	}

	h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&enrollment)
	return c.JSON(fiber.Map{
		"data": enrollment,
	})
}

func (h *EnrollmentHandler) Complete(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var enrollment models.Enrollment
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&enrollment).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Enrollment not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch enrollment",
		})
	}
	if !middleware.OwnsOrAdmin(c, enrollment.EmployeeID) {
		return middleware.Forbidden(c)
	}

	var req struct {
		Score *float64 `json:"score"`
	}
	if err := c.BodyParser(&req); err != nil {
		req.Score = nil
	}

	if enrollment.Status == "COMPLETED" {
		return c.Status(http.StatusConflict).JSON(fiber.Map{
			"error": "Enrollment is already completed",
		})
	}
	if enrollment.Status == "DROPPED" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Dropped enrollments cannot be completed",
		})
	}

	var course models.Course
	if err := h.DB.Where("id = ? AND tenant_id = ?", enrollment.CourseID, tenantID).First(&course).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Course not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch course",
		})
	}
	if enrollment.ProgressPct < course.CompletionThresholdPct {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": fmt.Sprintf("Progress %.2f is below completion threshold %.2f", enrollment.ProgressPct, course.CompletionThresholdPct),
		})
	}

	var assessments []models.Assessment
	if err := h.DB.Where("course_id = ? AND tenant_id = ?", enrollment.CourseID, tenantID).Find(&assessments).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch assessments",
		})
	}
	effectiveScore := enrollment.Score
	if req.Score != nil {
		effectiveScore = req.Score
	}
	if len(assessments) > 0 {
		if effectiveScore == nil {
			return c.Status(http.StatusBadRequest).JSON(fiber.Map{
				"error": "Score is required to complete an assessed course",
			})
		}
		for _, a := range assessments {
			if *effectiveScore < a.PassingScore {
				return c.Status(http.StatusBadRequest).JSON(fiber.Map{
					"error": fmt.Sprintf("Score %.2f is below passing score %.2f", *effectiveScore, a.PassingScore),
				})
			}
		}
	}

	now := time.Now()
	certID := ""
	if enrollment.CertificateID != nil && *enrollment.CertificateID != "" {
		certID = *enrollment.CertificateID
	} else {
		certID = fmt.Sprintf("CERT-%s-%s", enrollment.EmployeeID, uuid.New().String()[:8])
	}
	updates := map[string]interface{}{
		"status":         "COMPLETED",
		"progress_pct":   100.00,
		"completed_at":   &now,
		"certificate_id": certID,
	}
	if req.Score != nil {
		updates["score"] = *req.Score
	}
	if enrollment.StartedAt == nil {
		updates["started_at"] = &now
	}

	if err := h.DB.Model(&enrollment).Updates(updates).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to complete enrollment",
		})
	}

	h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&enrollment)
	return c.JSON(fiber.Map{
		"data": enrollment,
	})
}

func (h *EnrollmentHandler) Drop(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var enrollment models.Enrollment
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&enrollment).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Enrollment not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch enrollment",
		})
	}
	if !middleware.OwnsOrAdmin(c, enrollment.EmployeeID) {
		return middleware.Forbidden(c)
	}

	if err := h.DB.Model(&enrollment).Update("status", "DROPPED").Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to drop enrollment",
		})
	}

	return c.JSON(fiber.Map{
		"message": "Enrollment dropped successfully",
	})
}

func (h *EnrollmentHandler) BulkEnroll(c *fiber.Ctx) error {
	// Bulk enrollment multiplies impact by the size of the list, so it stays
	// restricted to the roles that can manage enrollments at all.
	if !middleware.CanManageContent(c) {
		return middleware.Forbidden(c)
	}
	tenantID := middleware.GetTenant(c)

	var req struct {
		CourseID    string   `json:"course_id"`
		EmployeeIDs []string `json:"employee_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}
	if req.CourseID == "" || len(req.EmployeeIDs) == 0 {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "course_id and employee_ids are required",
		})
	}

	var course models.Course
	if err := h.DB.Where("id = ? AND tenant_id = ?", req.CourseID, tenantID).First(&course).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Course not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch course",
		})
	}
	if course.Status != "PUBLISHED" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Course must be published before enrollment",
		})
	}

	tx := h.DB.Begin()
	if tx.Error != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to start enrollment transaction",
		})
	}
	committed := false
	defer func() {
		if !committed {
			tx.Rollback()
		}
	}()

	type bulkDetail struct {
		EmployeeID string `json:"employee_id"`
		Status     string `json:"status"`
		Reason     string `json:"reason,omitempty"`
	}

	var created []models.Enrollment
	var details []bulkDetail
	var skipped int

	for _, empID := range req.EmployeeIDs {
		if empID == "" {
			details = append(details, bulkDetail{EmployeeID: empID, Status: "failed", Reason: "employee_id is required"})
			continue
		}
		var existing models.Enrollment
		result := tx.Set("gorm:query_option", "FOR UPDATE").Where("course_id = ? AND employee_id = ? AND tenant_id = ?",
			req.CourseID, empID, tenantID).First(&existing)
		if result.Error == nil {
			skipped++
			details = append(details, bulkDetail{EmployeeID: empID, Status: "skipped", Reason: "already enrolled"})
			continue
		}

		enrollment := models.Enrollment{
			ID:         uuid.New().String(),
			TenantID:   tenantID,
			CourseID:   req.CourseID,
			EmployeeID: empID,
			Status:     "ENROLLED",
		}
		if err := tx.Create(&enrollment).Error; err != nil {
			details = append(details, bulkDetail{EmployeeID: empID, Status: "failed", Reason: "failed to enroll employee"})
			continue
		}
		created = append(created, enrollment)
		details = append(details, bulkDetail{EmployeeID: empID, Status: "enrolled"})
	}

	if err := tx.Commit().Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to complete bulk enrollment",
		})
	}
	committed = true
	if details == nil {
		details = []bulkDetail{}
	}

	return c.Status(http.StatusCreated).JSON(fiber.Map{
		"data":     created,
		"enrolled": len(created),
		"skipped":  skipped,
		"details":  details,
	})
}
