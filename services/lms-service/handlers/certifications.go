package handlers

import (
	"net/http"
	"strconv"
	"time"

	"github.com/atlas-workforce/lms-service/middleware"
	"github.com/atlas-workforce/lms-service/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"gorm.io/gorm"
)

type CertificationHandler struct {
	DB *gorm.DB
}

func (h *CertificationHandler) List(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	query := h.DB.Where("tenant_id = ?", tenantID)

	if employeeID := c.Query("employee_id"); employeeID != "" {
		query = query.Where("employee_id = ?", employeeID)
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
	h.DB.Model(&models.Certification{}).Where("tenant_id = ?", tenantID).Count(&total)

	var certifications []models.Certification
	if err := query.Order("created_at DESC").Offset(offset).Limit(pageSize).Find(&certifications).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch certifications",
		})
	}

	return c.JSON(fiber.Map{
		"data":      certifications,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

func (h *CertificationHandler) Create(c *fiber.Ctx) error {
	if !middleware.CanManageContent(c) {
		return middleware.Forbidden(c)
	}
	tenantID := middleware.GetTenant(c)

	var req struct {
		EmployeeID       string   `json:"employee_id"`
		Name             string   `json:"name"`
		IssuingAuthority string   `json:"issuing_authority"`
		IssueDate        string   `json:"issue_date"`
		ExpiryDate       string   `json:"expiry_date"`
		CredentialURL    string   `json:"credential_url"`
		Skills           []string `json:"skills"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}
	if req.EmployeeID == "" || req.Name == "" {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "employee_id and name are required",
		})
	}

	cert := models.Certification{
		ID:               uuid.New().String(),
		TenantID:         tenantID,
		EmployeeID:       req.EmployeeID,
		Name:             req.Name,
		IssuingAuthority: req.IssuingAuthority,
		CredentialURL:    req.CredentialURL,
		Skills:           pq.StringArray(req.Skills),
		Status:           "ACTIVE",
	}
	if req.IssueDate != "" {
		t, err := time.Parse("2006-01-02", req.IssueDate)
		if err == nil {
			cert.IssueDate = &t
		}
	}
	if req.ExpiryDate != "" {
		t, err := time.Parse("2006-01-02", req.ExpiryDate)
		if err == nil {
			cert.ExpiryDate = &t
		}
	}

	if err := h.DB.Create(&cert).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to create certification",
		})
	}

	return c.Status(http.StatusCreated).JSON(fiber.Map{
		"data": cert,
	})
}

func (h *CertificationHandler) Update(c *fiber.Ctx) error {
	if !middleware.CanManageContent(c) {
		return middleware.Forbidden(c)
	}
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var cert models.Certification
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&cert).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Certification not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch certification",
		})
	}

	var req struct {
		Name             string   `json:"name"`
		IssuingAuthority string   `json:"issuing_authority"`
		IssueDate        string   `json:"issue_date"`
		ExpiryDate       string   `json:"expiry_date"`
		CredentialURL    string   `json:"credential_url"`
		Skills           []string `json:"skills"`
		Status           string   `json:"status"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(http.StatusBadRequest).JSON(fiber.Map{
			"error": "Invalid request body",
		})
	}

	updates := map[string]interface{}{
		"name":              req.Name,
		"issuing_authority": req.IssuingAuthority,
		"credential_url":    req.CredentialURL,
		"status":            req.Status,
	}
	if req.Skills != nil {
		updates["skills"] = pq.StringArray(req.Skills)
	}
	if req.IssueDate != "" {
		t, err := time.Parse("2006-01-02", req.IssueDate)
		if err == nil {
			updates["issue_date"] = &t
		}
	}
	if req.ExpiryDate != "" {
		t, err := time.Parse("2006-01-02", req.ExpiryDate)
		if err == nil {
			updates["expiry_date"] = &t
		}
	}

	if err := h.DB.Model(&cert).Updates(updates).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to update certification",
		})
	}

	h.DB.First(&cert, "id = ?", id)
	return c.JSON(fiber.Map{
		"data": cert,
	})
}

func (h *CertificationHandler) Verify(c *fiber.Ctx) error {
	// Verification is an attestation that a credential is genuine, so it
	// stays with admins even though instructors can edit certification rows.
	if !middleware.IsAdmin(c) {
		return middleware.Forbidden(c)
	}
	tenantID := middleware.GetTenant(c)
	id := c.Params("id")

	var cert models.Certification
	if err := h.DB.Where("id = ? AND tenant_id = ?", id, tenantID).First(&cert).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return c.Status(http.StatusNotFound).JSON(fiber.Map{
				"error": "Certification not found",
			})
		}
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch certification",
		})
	}

	if err := h.DB.Model(&cert).Update("verified", true).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to verify certification",
		})
	}

	cert.Verified = true
	return c.JSON(fiber.Map{
		"data": cert,
	})
}

func (h *CertificationHandler) Expiring(c *fiber.Ctx) error {
	tenantID := middleware.GetTenant(c)

	daysStr := c.Query("days", "30")
	days, err := strconv.Atoi(daysStr)
	if err != nil || days < 1 {
		days = 30
	}

	cutoff := time.Now().UTC().AddDate(0, 0, days)

	var certifications []models.Certification
	if err := h.DB.Where("tenant_id = ? AND status = ? AND expiry_date IS NOT NULL AND expiry_date <= ?",
		tenantID, "ACTIVE", cutoff).Order("expiry_date ASC").Find(&certifications).Error; err != nil {
		return c.Status(http.StatusInternalServerError).JSON(fiber.Map{
			"error": "Failed to fetch expiring certifications",
		})
	}

	return c.JSON(fiber.Map{
		"data":           certifications,
		"expiring_within": days,
	})
}
