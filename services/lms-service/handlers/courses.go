package handlers

import (
	"net/http"

	"github.com/atlas-workforce/lms-service/middleware"
	"github.com/atlas-workforce/lms-service/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"gorm.io/gorm"
)

type CourseHandler struct {
	DB *gorm.DB
}

func (h *CourseHandler) List(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	type CourseWithCount struct {
		models.Course
		EnrollmentCount int64 `json:"enrollment_count"`
	}

	var courses []CourseWithCount

	query := h.DB.Table("courses").
		Select("courses.*, COUNT(enrollments.id) as enrollment_count").
		Joins("LEFT JOIN enrollments ON enrollments.course_id = courses.id").
		Where("courses.tenant_id = ?", tenantID)

	if category := c.Query("category"); category != "" {
		query = query.Where("courses.category = ?", category)
	}
	if level := c.Query("level"); level != "" {
		query = query.Where("courses.level = ?", level)
	}
	if status := c.Query("status"); status != "" {
		query = query.Where("courses.status = ?", status)
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
	countQuery := h.DB.Model(&models.Course{}).Where("tenant_id = ?", tenantID)
	if category := c.Query("category"); category != "" {
		countQuery = countQuery.Where("category = ?", category)
	}
	if level := c.Query("level"); level != "" {
		countQuery = countQuery.Where("level = ?", level)
	}
	if status := c.Query("status"); status != "" {
		countQuery = countQuery.Where("status = ?", status)
	}
	countQuery.Count(&total)

	if err := query.Group("courses.id").Order("courses.created_at DESC").
		Offset(offset).Limit(pageSize).Find(&courses).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch courses",
		})
	}

	return c.JSON(fiber.Map{
		"data":      courses,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

func (h *CourseHandler) Get(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var course models.Course
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).
		Preload("Enrollments").First(&course).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Course not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch course",
		})
	}

	enrollmentCount := int64(len(course.Enrollments))
	course.Enrollments = nil

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"course":           course,
			"enrollment_count": enrollmentCount,
		},
	})
}

func (h *CourseHandler) Create(c *fiber.Ctx) error {
	if !middleware.CanManageContent(c) {
		return middleware.Forbidden(c)
	}
	tenantID := middleware.GetTenant(c)

	var req struct {
		Title                  string   `json:"title"`
		Description            string   `json:"description"`
		Category               string   `json:"category"`
		Level                  string   `json:"level"`
		DurationMinutes        int      `json:"duration_minutes"`
		Instructor             string   `json:"instructor"`
		ThumbnailURL           string   `json:"thumbnail_url"`
		ContentURL             string   `json:"content_url"`
		Skills                 []string `json:"skills"`
		IsMandatory            *bool    `json:"is_mandatory"`
		CompletionThresholdPct *float64 `json:"completion_threshold_pct"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}
	if req.Title == "" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Title is required",
		})
	}

	course := models.Course{
		ID:       uuid.New().String(),
		TenantID: tenantID,
		Title:    req.Title,
		Status:   "DRAFT",
	}
	if req.Description != "" {
		course.Description = req.Description
	}
	if req.Category != "" {
		course.Category = req.Category
	}
	if req.Level != "" {
		course.Level = req.Level
	}
	course.DurationMinutes = req.DurationMinutes
	if req.Instructor != "" {
		course.Instructor = req.Instructor
	}
	if req.ThumbnailURL != "" {
		course.ThumbnailURL = req.ThumbnailURL
	}
	if req.ContentURL != "" {
		course.ContentURL = req.ContentURL
	}
	if req.Skills != nil {
		course.Skills = pq.StringArray(req.Skills)
	}
	if req.IsMandatory != nil {
		course.IsMandatory = *req.IsMandatory
	}
	if req.CompletionThresholdPct != nil {
		course.CompletionThresholdPct = *req.CompletionThresholdPct
	} else {
		course.CompletionThresholdPct = 80.00
	}

	if err := h.DB.Create(&course).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to create course",
		})
	}

	return c.Status(http.StatusCreated).JSON(fiber.Map{
		"data": course,
	})
}

func (h *CourseHandler) Update(c *fiber.Ctx) error {
	if !middleware.CanManageContent(c) {
		return middleware.Forbidden(c)
	}
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var course models.Course
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&course).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Course not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch course",
		})
	}

	var req struct {
		Title                  string   `json:"title"`
		Description            string   `json:"description"`
		Category               string   `json:"category"`
		Level                  string   `json:"level"`
		DurationMinutes        int      `json:"duration_minutes"`
		Instructor             string   `json:"instructor"`
		ThumbnailURL           string   `json:"thumbnail_url"`
		ContentURL             string   `json:"content_url"`
		Skills                 []string `json:"skills"`
		IsMandatory            *bool    `json:"is_mandatory"`
		CompletionThresholdPct *float64 `json:"completion_threshold_pct"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}

	updates := map[string]interface{}{
		"title":        req.Title,
		"description":  req.Description,
		"category":     req.Category,
		"level":        req.Level,
		"instructor":   req.Instructor,
		"thumbnail_url": req.ThumbnailURL,
		"content_url":  req.ContentURL,
	}
	if req.DurationMinutes > 0 {
		updates["duration_minutes"] = req.DurationMinutes
	}
	if req.Skills != nil {
		updates["skills"] = pq.StringArray(req.Skills)
	}
	if req.IsMandatory != nil {
		updates["is_mandatory"] = *req.IsMandatory
	}
	if req.CompletionThresholdPct != nil {
		updates["completion_threshold_pct"] = *req.CompletionThresholdPct
	}

	if err := h.DB.Model(&course).Where("id = ? AND tenant_id = ?", id, tenantID).Updates(updates).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to update course",
		})
	}

	h.DB.First(&course, "id = ?", id)
	return c.JSON(fiber.Map{
		"data": course,
	})
}

func (h *CourseHandler) Delete(c *fiber.Ctx) error {
	if !middleware.CanManageContent(c) {
		return middleware.Forbidden(c)
	}
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var course models.Course
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&course).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Course not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch course",
		})
	}

	if err := h.DB.Delete(&course).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to delete course",
		})
	}

	return c.JSON(fiber.Map{
		"message": "Course deleted successfully",
	})
}

func (h *CourseHandler) Publish(c *fiber.Ctx) error {
	return h.updateStatus(c, "PUBLISHED")
}

func (h *CourseHandler) Archive(c *fiber.Ctx) error {
	return h.updateStatus(c, "ARCHIVED")
}

func (h *CourseHandler) GetEnrollments(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	courseID := c.Params("id")

	var course models.Course
	if err := h.DB.Where("id = ? AND tenant_id = ?", courseID, tenantID).First(&course).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Course not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch course",
		})
	}

	var enrollments []models.Enrollment
	if err := h.DB.Where("course_id = ? AND tenant_id = ?", courseID, tenantID).
		Order("created_at DESC").Find(&enrollments).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch enrollments",
		})
	}

	return c.JSON(fiber.Map{
		"data": enrollments,
	})
}

func (h *CourseHandler) updateStatus(c *fiber.Ctx, status string) error {
	if !middleware.CanManageContent(c) {
		return middleware.Forbidden(c)
	}
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var course models.Course
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&course).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Course not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch course",
		})
	}

	if err := h.DB.Model(&course).Update("status", status).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to update course status",
		})
	}

	course.Status = status
	return c.JSON(fiber.Map{
		"data": course,
	})
}
