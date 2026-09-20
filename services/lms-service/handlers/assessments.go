package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/atlas-workforce/lms-service/middleware"
	"github.com/atlas-workforce/lms-service/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

type AssessmentHandler struct {
	DB *gorm.DB
}

func (h *AssessmentHandler) List(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	query := h.DB.Where("tenant_id = ?", tenantID)
	if courseID := c.Query("course_id"); courseID != "" {
		query = query.Where("course_id = ?", courseID)
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
	h.DB.Model(&models.Assessment{}).Where("tenant_id = ?", tenantID).Count(&total)

	var assessments []models.Assessment
	if err := query.Preload("Course").Order("created_at DESC").
		Offset(offset).Limit(pageSize).Find(&assessments).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch assessments",
		})
	}

	return c.JSON(fiber.Map{
		"data":      assessments,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

func (h *AssessmentHandler) Create(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	var req struct {
		CourseID         string          `json:"course_id"`
		Title            string          `json:"title"`
		Description      string          `json:"description"`
		PassingScore     float64         `json:"passing_score"`
		MaxScore         float64         `json:"max_score"`
		TimeLimitMinutes int             `json:"time_limit_minutes"`
		Questions        json.RawMessage `json:"questions"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}
	if req.CourseID == "" || req.Title == "" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "course_id and title are required",
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

	assessment := models.Assessment{
		ID:               uuid.New().String(),
		TenantID:         tenantID,
		CourseID:         req.CourseID,
		Title:            req.Title,
		Description:      req.Description,
		PassingScore:     req.PassingScore,
		MaxScore:         req.MaxScore,
		TimeLimitMinutes: req.TimeLimitMinutes,
		Questions:        datatypes.JSON(req.Questions),
	}
	if assessment.MaxScore == 0 {
		assessment.MaxScore = 100.00
	}
	if assessment.PassingScore == 0 {
		assessment.PassingScore = assessment.MaxScore * 0.70
	}

	if err := h.DB.Create(&assessment).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to create assessment",
		})
	}

	return c.Status(http.StatusCreated).JSON(fiber.Map{
		"data": assessment,
	})
}

func (h *AssessmentHandler) Get(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var assessment models.Assessment
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).
		Preload("Course").First(&assessment).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Assessment not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch assessment",
		})
	}

	includeAnswers := c.Query("include_answers") == "true"

	if !includeAnswers && assessment.Questions != nil {
		var questions []map[string]interface{}
		if err := json.Unmarshal(assessment.Questions, &questions); err == nil {
			for i := range questions {
				delete(questions[i], "correct_answer")
			}
			sanitized, _ := json.Marshal(questions)
			assessment.Questions = datatypes.JSON(sanitized)
		}
	}

	return c.JSON(fiber.Map{
		"data": assessment,
	})
}

func (h *AssessmentHandler) Update(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var assessment models.Assessment
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&assessment).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Assessment not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch assessment",
		})
	}

	var req struct {
		Title            string          `json:"title"`
		Description      string          `json:"description"`
		PassingScore     *float64        `json:"passing_score"`
		MaxScore         *float64        `json:"max_score"`
		TimeLimitMinutes int             `json:"time_limit_minutes"`
		Questions        json.RawMessage `json:"questions"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}

	updates := map[string]interface{}{
		"title":        req.Title,
		"description":  req.Description,
		"time_limit_minutes": req.TimeLimitMinutes,
	}
	if req.PassingScore != nil {
		updates["passing_score"] = *req.PassingScore
	}
	if req.MaxScore != nil {
		updates["max_score"] = *req.MaxScore
	}
	if req.Questions != nil {
		updates["questions"] = datatypes.JSON(req.Questions)
	}

	if err := h.DB.Model(&assessment).Updates(updates).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to update assessment",
		})
	}

	h.DB.First(&assessment, "id = ?", id)
	return c.JSON(fiber.Map{
		"data": assessment,
	})
}

func (h *AssessmentHandler) StartAttempt(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	assessmentID := c.Params("id")

	var assessment models.Assessment
	if err := h.DB.Where("id = ? AND tenant_id = ?", assessmentID, tenantID).First(&assessment).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Assessment not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch assessment",
		})
	}

	var req struct {
		EmployeeID string `json:"employee_id"`
	}
	if err := c.BodyParser(&req); err != nil || req.EmployeeID == "" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "employee_id is required",
		})
	}

	var lastAttempt models.AssessmentAttempt
	h.DB.Where("assessment_id = ? AND employee_id = ? AND tenant_id = ?",
		assessmentID, req.EmployeeID, tenantID).
		Order("attempt_number DESC").First(&lastAttempt)

	attemptNumber := 1
	if lastAttempt.ID != "" {
		attemptNumber = lastAttempt.AttemptNumber + 1
	}

	now := time.Now()
	attempt := models.AssessmentAttempt{
		ID:            uuid.New().String(),
		TenantID:      tenantID,
		AssessmentID:  assessmentID,
		EmployeeID:    req.EmployeeID,
		AttemptNumber: attemptNumber,
		StartedAt:     &now,
	}

	if err := h.DB.Create(&attempt).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to start attempt",
		})
	}

	var questions []map[string]interface{}
	if err := json.Unmarshal(assessment.Questions, &questions); err == nil {
		for i := range questions {
			delete(questions[i], "correct_answer")
		}
	}

	return c.Status(http.StatusCreated).JSON(fiber.Map{
		"data": fiber.Map{
			"attempt_id": attempt.ID,
			"attempt_number": attemptNumber,
			"started_at":  now,
			"questions":   questions,
		},
	})
}

func (h *AssessmentHandler) SubmitAttempt(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	assessmentID := c.Params("id")

	var assessment models.Assessment
	if err := h.DB.Where("id = ? AND tenant_id = ?", assessmentID, tenantID).First(&assessment).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Assessment not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch assessment",
		})
	}

	var req struct {
		AttemptID  string          `json:"attempt_id"`
		EmployeeID string          `json:"employee_id"`
		Answers    json.RawMessage `json:"answers"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}
	if req.AttemptID == "" || req.EmployeeID == "" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "attempt_id and employee_id are required",
		})
	}

	var attempt models.AssessmentAttempt
	if err := h.DB.Where("id = ? AND assessment_id = ? AND employee_id = ? AND tenant_id = ?",
		req.AttemptID, assessmentID, req.EmployeeID, tenantID).First(&attempt).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Attempt not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch attempt",
		})
	}

	if attempt.CompletedAt != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Attempt already submitted",
		})
	}

	var questions []struct {
		Question      string   `json:"question"`
		Options       []string `json:"options"`
		CorrectAnswer string   `json:"correct_answer"`
		Points        float64  `json:"points"`
	}
	if err := json.Unmarshal(assessment.Questions, &questions); err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to parse assessment questions",
		})
	}

	var answersMap map[string]string
	if err := json.Unmarshal(req.Answers, &answersMap); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid answers format",
		})
	}

	totalScore := 0.0
	maxScore := 0.0
	for i, q := range questions {
		points := q.Points
		if points == 0 {
			points = 10
		}
		maxScore += points

		key := fmt.Sprintf("%d", i)
		if answer, ok := answersMap[key]; ok && answer == q.CorrectAnswer {
			totalScore += points
		}
	}

	if maxScore == 0 {
		maxScore = float64(len(questions)) * 10
		if maxScore == 0 {
			maxScore = 100
		}
	}

	effectiveMax := assessment.MaxScore
	if effectiveMax == 0 {
		effectiveMax = 100
	}
	var passingRatio float64
	if assessment.PassingScore <= 100 {
		passingRatio = assessment.PassingScore / 100.0
	} else {
		passingRatio = assessment.PassingScore / effectiveMax
	}
	actualRatio := 0.0
	if maxScore != 0 {
		actualRatio = totalScore / maxScore
	}
	passed := actualRatio >= passingRatio
	now := time.Now()

	updates := map[string]interface{}{
		"score":        &totalScore,
		"passed":       &passed,
		"answers":      datatypes.JSON(req.Answers),
		"completed_at": &now,
	}
	if err := h.DB.Model(&attempt).Updates(updates).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to submit attempt",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"attempt_id": attempt.ID,
			"score":      totalScore,
			"max_score":  maxScore,
			"passed":     passed,
			"completed_at": now,
		},
	})
}

func (h *AssessmentHandler) GetAttempts(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	assessmentID := c.Params("id")

	var assessment models.Assessment
	if err := h.DB.Where("id = ? AND tenant_id = ?", assessmentID, tenantID).First(&assessment).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Assessment not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch assessment",
		})
	}

	query := h.DB.Where("assessment_id = ? AND tenant_id = ?", assessmentID, tenantID)
	if employeeID := c.Query("employee_id"); employeeID != "" {
		query = query.Where("employee_id = ?", employeeID)
	}

	var attempts []models.AssessmentAttempt
	if err := query.Order("attempt_number DESC").Find(&attempts).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch attempts",
		})
	}

	return c.JSON(fiber.Map{
		"data": attempts,
	})
}
