package handlers

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/atlas-workforce/lms-service/middleware"
	"github.com/atlas-workforce/lms-service/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type LearningAnalyticsHandler struct {
	DB *gorm.DB
}

func (h *LearningAnalyticsHandler) Overview(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	var totalCourses, pubCourses int64
	if err := h.DB.Model(&models.Course{}).Where("tenant_id = ?", tenantID).Count(&totalCourses).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to query courses"})
	}
	if err := h.DB.Model(&models.Course{}).Where("tenant_id = ? AND status = ?", tenantID, "PUBLISHED").Count(&pubCourses).Error; err != nil {
		log.Printf("learning_analytics Overview pubCourses: %v", err)
	}

	var totalEnrollments, completedEnrollments, inProgress int64
	if err := h.DB.Model(&models.Enrollment{}).Where("tenant_id = ?", tenantID).Count(&totalEnrollments).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to query enrollments"})
	}
	if err := h.DB.Model(&models.Enrollment{}).Where("tenant_id = ? AND status = ?", tenantID, "COMPLETED").Count(&completedEnrollments).Error; err != nil {
		log.Printf("learning_analytics Overview completed: %v", err)
	}
	if err := h.DB.Model(&models.Enrollment{}).Where("tenant_id = ? AND status = ?", tenantID, "IN_PROGRESS").Count(&inProgress).Error; err != nil {
		log.Printf("learning_analytics Overview inProgress: %v", err)
	}

	var totalCerts, activeCerts, expiringCerts int64
	if err := h.DB.Model(&models.Certification{}).Where("tenant_id = ?", tenantID).Count(&totalCerts).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to query certifications"})
	}
	if err := h.DB.Model(&models.Certification{}).Where("tenant_id = ? AND status = ?", tenantID, "ACTIVE").Count(&activeCerts).Error; err != nil {
		log.Printf("learning_analytics Overview activeCerts: %v", err)
	}
	if err := h.DB.Raw("SELECT COUNT(*) FROM certifications WHERE tenant_id = ? AND status = 'ACTIVE' AND expiry_date IS NOT NULL AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL '30 days'", tenantID).Scan(&expiringCerts).Error; err != nil {
		log.Printf("learning_analytics Overview expiring: %v", err)
	}

	var totalAssessments, totalAttempts, passedAttempts int64
	if err := h.DB.Model(&models.Assessment{}).Where("tenant_id = ?", tenantID).Count(&totalAssessments).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to query assessments"})
	}
	if err := h.DB.Model(&models.AssessmentAttempt{}).Where("tenant_id = ?", tenantID).Count(&totalAttempts).Error; err != nil {
		log.Printf("learning_analytics Overview totalAttempts: %v", err)
	}
	if err := h.DB.Model(&models.AssessmentAttempt{}).Where("tenant_id = ? AND passed = ?", tenantID, true).Count(&passedAttempts).Error; err != nil {
		log.Printf("learning_analytics Overview passedAttempts: %v", err)
	}

	var totalSkills, totalJourneys int64
	if err := h.DB.Model(&models.SkillMatrix{}).Where("tenant_id = ?", tenantID).Count(&totalSkills).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to query skills"})
	}
	if err := h.DB.Model(&models.LearningJourney{}).Where("tenant_id = ?", tenantID).Count(&totalJourneys).Error; err != nil {
		log.Printf("learning_analytics Overview totalJourneys: %v", err)
	}

	var totalCompliance, completedCompliance int64
	if err := h.DB.Model(&models.ComplianceTraining{}).Where("tenant_id = ?", tenantID).Count(&totalCompliance).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to query compliance"})
	}
	if err := h.DB.Model(&models.ComplianceTraining{}).Where("tenant_id = ? AND status = ?", tenantID, "COMPLETED").Count(&completedCompliance).Error; err != nil {
		log.Printf("learning_analytics Overview completedCompliance: %v", err)
	}

	var totalKnowledge, totalMarketplace int64
	if err := h.DB.Model(&models.KnowledgeArticle{}).Where("tenant_id = ?", tenantID).Count(&totalKnowledge).Error; err != nil {
		log.Printf("learning_analytics Overview totalKnowledge: %v", err)
	}
	if err := h.DB.Model(&models.MarketplaceListing{}).Where("tenant_id = ?", tenantID).Count(&totalMarketplace).Error; err != nil {
		log.Printf("learning_analytics Overview totalMarketplace: %v", err)
	}

	completionRate := 0.0
	if totalEnrollments > 0 {
		completionRate = float64(completedEnrollments) / float64(totalEnrollments) * 100
	}
	passRate := 0.0
	if totalAttempts > 0 {
		passRate = float64(passedAttempts) / float64(totalAttempts) * 100
	}
	complianceRate := 0.0
	if totalCompliance > 0 {
		complianceRate = float64(completedCompliance) / float64(totalCompliance) * 100
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"courses":           fiber.Map{"total": totalCourses, "published": pubCourses},
			"enrollments":       fiber.Map{"total": totalEnrollments, "completed": completedEnrollments, "in_progress": inProgress},
			"completion_rate":   completionRate,
			"certifications":    fiber.Map{"total": totalCerts, "active": activeCerts, "expiring_30d": expiringCerts},
			"assessments":       fiber.Map{"total": totalAssessments, "attempts": totalAttempts, "passed": passedAttempts},
			"pass_rate":         passRate,
			"skills":            fiber.Map{"total": totalSkills},
			"journeys":          fiber.Map{"total": totalJourneys},
			"compliance":        fiber.Map{"total": totalCompliance, "completed": completedCompliance, "rate": complianceRate},
			"knowledge_articles": totalKnowledge,
			"marketplace_listings": totalMarketplace,
			"mentors":           0,
		},
	})
}

func (h *LearningAnalyticsHandler) Department(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	var deptStats []struct {
		EmployeeID    string `json:"employee_id"`
		TotalEnrolled int64  `json:"total_enrolled"`
		Completed     int64  `json:"completed"`
		InProgress    int64  `json:"in_progress"`
	}
	if err := h.DB.Raw(`
		SELECT e.employee_id,
			COUNT(*) as total_enrolled,
			SUM(CASE WHEN e.status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
			SUM(CASE WHEN e.status = 'IN_PROGRESS' THEN 1 ELSE 0 END) as in_progress
		FROM enrollments e
		WHERE e.tenant_id = ?
		GROUP BY e.employee_id
		ORDER BY total_enrolled DESC
		LIMIT 10`, tenantID).Scan(&deptStats).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch department stats"})
	}

	return c.JSON(fiber.Map{"data": deptStats})
}

func (h *LearningAnalyticsHandler) Trends(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	period := c.Query("period", "monthly")

	var trends []struct {
		Period     string `json:"period"`
		Enrollments int64  `json:"enrollments"`
		Completions int64  `json:"completions"`
	}
	trunc := "DATE_TRUNC('month', created_at)::date"
	if period == "weekly" {
		trunc = "DATE_TRUNC('week', created_at)::date"
	}

	if err := h.DB.Raw(`
		SELECT `+trunc+` as period,
			COUNT(*) as enrollments,
			SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completions
		FROM enrollments
		WHERE tenant_id = ? AND created_at > NOW() - INTERVAL '12 months'
		GROUP BY period
		ORDER BY period ASC`, tenantID).Scan(&trends).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch trends"})
	}

	return c.JSON(fiber.Map{"data": trends})
}

func (h *LearningAnalyticsHandler) CompetencyMatrix(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	var frameworks []models.CompetencyFramework
	if err := h.DB.Where("tenant_id = ? AND status = ?", tenantID, "ACTIVE").Find(&frameworks).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch frameworks"})
	}

	var allSkills []models.SkillMatrix
	if err := h.DB.Where("tenant_id = ?", tenantID).Find(&allSkills).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch skills"})
	}

	empSkillMap := make(map[string]map[string]models.SkillMatrix)
	for _, s := range allSkills {
		if empSkillMap[s.EmployeeID] == nil {
			empSkillMap[s.EmployeeID] = make(map[string]models.SkillMatrix)
		}
		empSkillMap[s.EmployeeID][s.Skill] = s
	}

	type CompetencyResult struct {
		Framework         models.CompetencyFramework `json:"framework"`
		EmployeeCount     int                        `json:"employee_count"`
		AvgScore          float64                    `json:"avg_score"`
		QualifiedCount    int                        `json:"qualified_count"`
	}
	var results []CompetencyResult
	for _, fw := range frameworks {
		comps := []string{}
		var compList []interface{}
		if err := json.Unmarshal(fw.Competencies, &compList); err == nil {
			for _, comp := range compList {
				if m, ok := comp.(map[string]interface{}); ok {
					if s, ok := m["skill"].(string); ok {
						comps = append(comps, s)
					}
				}
			}
		}
		employeeIDs := map[string]bool{}
		for _, s := range allSkills {
			employeeIDs[s.EmployeeID] = true
		}
		qualifiedCount := 0
		for empID := range employeeIDs {
			hasAll := true
			for _, comp := range comps {
				if _, ok := empSkillMap[empID][comp]; !ok {
					hasAll = false
					break
				}
			}
			if hasAll {
				qualifiedCount++
			}
		}
		results = append(results, CompetencyResult{
			Framework:      fw,
			EmployeeCount:  len(employeeIDs),
			AvgScore:       float64(qualifiedCount) / float64(max(len(employeeIDs), 1)) * 100,
			QualifiedCount: qualifiedCount,
		})
	}
	return c.JSON(fiber.Map{"data": results})
}

func max(a, b int) int {
	if a > b { return a }
	return b
}

type SkillEndorsementHandler struct {
	DB *gorm.DB
}

func (h *SkillEndorsementHandler) List(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	employeeID := c.Query("employee_id")
	skillID := c.Query("skill_id")
	query := h.DB.Where("tenant_id = ?", tenantID)
	if employeeID != "" { query = query.Where("employee_id = ?", employeeID) }
	if skillID != "" { query = query.Where("skill_id = ?", skillID) }
	var endorsements []models.SkillEndorsement
	if err := query.Order("created_at DESC").Find(&endorsements).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to fetch endorsements"})
	}
	return c.JSON(fiber.Map{"data": endorsements})
}

func (h *SkillEndorsementHandler) Create(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	var req struct {
		SkillID      string `json:"skill_id"`
		EmployeeID   string `json:"employee_id"`
		EndorsedBy   string `json:"endorsed_by"`
		EndorserName string `json:"endorser_name"`
		SkillName    string `json:"skill_name"`
		Proficiency  string `json:"proficiency"`
		Comment      string `json:"comment"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request"})
	}
	endorsement := models.SkillEndorsement{
		ID:           uuid.New().String(),
		TenantID:     tenantID,
		SkillID:      req.SkillID,
		EmployeeID:   req.EmployeeID,
		EndorsedBy:   req.EndorsedBy,
		EndorserName: req.EndorserName,
		SkillName:    req.SkillName,
		Proficiency:  req.Proficiency,
		Comment:      req.Comment,
	}
	if err := h.DB.Create(&endorsement).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to create endorsement"})
	}
	if req.SkillID != "" {
		if err := h.DB.Model(&models.SkillMatrix{}).Where("id = ? AND tenant_id = ?", req.SkillID, tenantID).
			Update("endorsed_by", req.EndorsedBy).Error; err != nil {
			log.Printf("SkillEndorsementHandler.Create update skill matrix: %v", err)
		}
	}
	return c.Status(http.StatusCreated).JSON(fiber.Map{"data": endorsement})
}

func (h *SkillEndorsementHandler) Delete(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).Delete(&models.SkillEndorsement{}).Error; err != nil {
		return c.Status(http.StatusNotFound).JSON(fiber.Map{"error": "Endorsement not found"})
	}
	return c.JSON(fiber.Map{"message": "Endorsement deleted"})
}
