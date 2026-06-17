package main

import (
	"fmt"
	"log"
	"os"
	"regexp"
	"time"

	"github.com/atlas-workforce/lms-service/handlers"
	"github.com/atlas-workforce/lms-service/middleware"
	"github.com/atlas-workforce/lms-service/models"
	"github.com/gofiber/adaptor/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var (
	httpRequestCount = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "atlas_http_requests_total",
			Help: "Total HTTP requests",
		},
		[]string{"method", "path", "status_code"},
	)
	httpRequestDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "atlas_http_request_duration_seconds",
			Help:    "HTTP request duration in seconds",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0},
		},
		[]string{"method", "path", "status_code"},
	)
	httpRequestsInProgress = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "atlas_http_requests_in_progress",
			Help: "Number of HTTP requests in progress",
		},
		[]string{"method", "path"},
	)
	pathParamPattern = regexp.MustCompile(`/[0-9a-fA-F-]{36}|/\d+`)
)

func init() {
	prometheus.MustRegister(httpRequestCount)
	prometheus.MustRegister(httpRequestDuration)
	prometheus.MustRegister(httpRequestsInProgress)
}

var db *gorm.DB

func main() {
	dbHost := getEnv("DB_HOST", "localhost")
	dbPort := getEnv("DB_PORT", "5432")
	dbUser := getEnv("DB_USER", "postgres")
	dbPassword := getEnv("DB_PASSWORD", "postgres")
	dbName := getEnv("DB_NAME", "atlas_lms")
	dbSSLMode := getEnv("DB_SSLMODE", "disable")
	serverPort := getEnv("SERVER_PORT", "8013")

	dsn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s",
		dbHost, dbPort, dbUser, dbPassword, dbName, dbSSLMode)

	var err error
	db, err = gorm.Open(postgres.Open(dsn), &gorm.Config{
		SkipDefaultTransaction: true,
	})
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		log.Fatalf("Failed to get underlying DB: %v", err)
	}
	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetMaxOpenConns(100)

	db.Exec("CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"")

	if err := db.AutoMigrate(
		&models.Course{},
		&models.Enrollment{},
		&models.Certification{},
		&models.Assessment{},
		&models.AssessmentAttempt{},
		&models.LearningPath{},
		&models.SkillMatrix{},
		&models.ComplianceTraining{},
		&models.LearningRecommendation{},
		&models.MentorProfile{},
		&models.MentorSession{},
		&models.MarketplaceListing{},
		&models.KnowledgeArticle{},
		&models.SkillEndorsement{},
		&models.CompetencyFramework{},
		&models.LearningJourney{},
	); err != nil {
		log.Fatalf("Failed to auto-migrate: %v", err)
	}

	app := fiber.New(fiber.Config{
		AppName: "Atlas LMS Service",
	})

	app.Use(recover.New())
	app.Use(logger.New())
	app.Use(cors.New())

	app.Use(func(c *fiber.Ctx) error {
		path := pathParamPattern.ReplaceAllString(c.Path(), "/:param")
		httpRequestsInProgress.WithLabelValues(c.Method(), path).Inc()
		start := time.Now()
		err := c.Next()
		duration := time.Since(start).Seconds()
		status := fiber.StatusInternalServerError
		if err != nil {
			if e, ok := err.(*fiber.Error); ok {
				status = e.Code
			}
		} else {
			status = c.Response().StatusCode()
		}
		httpRequestsInProgress.WithLabelValues(c.Method(), path).Dec()
		httpRequestCount.WithLabelValues(c.Method(), path, fmt.Sprintf("%d", status)).Inc()
		httpRequestDuration.WithLabelValues(c.Method(), path, fmt.Sprintf("%d", status)).Observe(duration)
		return err
	})

	app.Get("/metrics", adaptor.HTTPHandler(promhttp.Handler()))

	middleware.InitAuth()
	app.Use(middleware.AuthMiddleware())
	app.Use(middleware.TenantMiddleware())

	go startCertExpiryChecker()

	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "LMS Service is running"})
	})

	setupRoutes(app)

	log.Printf("LMS Service starting on port %s", serverPort)
	if err := app.Listen(":" + serverPort); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func startCertExpiryChecker() {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	// Run once at startup
	checkExpiringCertifications()

	for range ticker.C {
		checkExpiringCertifications()
	}
}

func checkExpiringCertifications() {
	if db == nil {
		return
	}

	cutoff := time.Now().AddDate(0, 0, 30)
	var expiring []struct {
		ID         string
		EmployeeID string
		Name       string
		ExpiryDate *time.Time
	}

	db.Table("certifications").
		Select("id, employee_id, name, expiry_date").
		Where("status = ? AND expiry_date IS NOT NULL AND expiry_date <= ?", "ACTIVE", cutoff).
		Find(&expiring)

	for _, c := range expiring {
		if c.ExpiryDate != nil {
			daysLeft := int(time.Until(*c.ExpiryDate).Hours() / 24)
			log.Printf("WARNING: Certification '%s' for employee %s expires in %d days (on %s)",
				c.Name, c.EmployeeID, daysLeft, c.ExpiryDate.Format("2006-01-02"))
		}
	}
}

func setupRoutes(app *fiber.App) {
	courseHandler := &handlers.CourseHandler{DB: db}
	enrollmentHandler := &handlers.EnrollmentHandler{DB: db}
	certHandler := &handlers.CertificationHandler{DB: db}
	assessmentHandler := &handlers.AssessmentHandler{DB: db}
	pathHandler := &handlers.LearningPathHandler{DB: db}
	skillHandler := &handlers.SkillHandler{DB: db}
	dashHandler := &handlers.DashboardHandler{DB: db}

	complianceHandler := &handlers.ComplianceHandler{DB: db}
	recHandler := &handlers.RecommendationHandler{DB: db}
	journeyHandler := &handlers.JourneyHandler{DB: db}
	mentorHandler := &handlers.MentorHandler{DB: db}
	sessionHandler := &handlers.MentorSessionHandler{DB: db}
	marketplaceHandler := &handlers.MarketplaceHandler{DB: db}
	knowledgeHandler := &handlers.KnowledgeHandler{DB: db}
	analyticsHandler := &handlers.LearningAnalyticsHandler{DB: db}
	endorsementHandler := &handlers.SkillEndorsementHandler{DB: db}

	v1 := app.Group("/api/v1")

	courses := v1.Group("/courses")
	courses.Get("/", courseHandler.List)
	courses.Post("/", courseHandler.Create)
	courses.Get("/:id", courseHandler.Get)
	courses.Put("/:id", courseHandler.Update)
	courses.Delete("/:id", courseHandler.Delete)
	courses.Post("/:id/publish", courseHandler.Publish)
	courses.Post("/:id/archive", courseHandler.Archive)
	courses.Get("/:id/enrollments", courseHandler.GetEnrollments)

	enrollments := v1.Group("/enrollments")
	enrollments.Get("/", enrollmentHandler.List)
	enrollments.Post("/", enrollmentHandler.Enroll)
	enrollments.Post("/bulk", enrollmentHandler.BulkEnroll)
	enrollments.Put("/:id/progress", enrollmentHandler.UpdateProgress)
	enrollments.Put("/:id/complete", enrollmentHandler.Complete)
	enrollments.Delete("/:id", enrollmentHandler.Drop)

	certifications := v1.Group("/certifications")
	certifications.Get("/", certHandler.List)
	certifications.Post("/", certHandler.Create)
	certifications.Get("/expiring", certHandler.Expiring)
	certifications.Put("/:id", certHandler.Update)
	certifications.Put("/:id/verify", certHandler.Verify)

	assessments := v1.Group("/assessments")
	assessments.Get("/", assessmentHandler.List)
	assessments.Post("/", assessmentHandler.Create)
	assessments.Get("/:id", assessmentHandler.Get)
	assessments.Put("/:id", assessmentHandler.Update)
	assessments.Post("/:id/attempt", assessmentHandler.StartAttempt)
	assessments.Put("/:id/attempt", assessmentHandler.SubmitAttempt)
	assessments.Get("/:id/attempts", assessmentHandler.GetAttempts)

	paths := v1.Group("/learning-paths")
	paths.Get("/", pathHandler.List)
	paths.Post("/", pathHandler.Create)
	paths.Get("/:id", pathHandler.Get)
	paths.Put("/:id", pathHandler.Update)
	paths.Delete("/:id", pathHandler.Delete)

	skills := v1.Group("/skills")
	skills.Get("/", skillHandler.List)
	skills.Post("/", skillHandler.Upsert)
	skills.Get("/gap-analysis", skillHandler.GapAnalysis)
	skills.Get("/matrix", skillHandler.Matrix)
	skills.Get("/:employee_id", skillHandler.GetEmployeeSkills)

	dashboard := v1.Group("/dashboard")
	dashboard.Get("/summary", dashHandler.Summary)
	dashboard.Get("/employee/:employee_id", dashHandler.Employee)

	// Learning & Development routes
	learning := v1.Group("/learning")

	compliance := learning.Group("/compliance")
	compliance.Get("/", complianceHandler.List)
	compliance.Post("/", complianceHandler.Create)
	compliance.Put("/:id", complianceHandler.Update)
	compliance.Delete("/:id", complianceHandler.Delete)
	compliance.Get("/dashboard", complianceHandler.Dashboard)

	recommendations := learning.Group("/recommendations")
	recommendations.Get("/", recHandler.List)
	recommendations.Post("/generate", recHandler.Generate)
	recommendations.Put("/:id/acknowledge", recHandler.Acknowledge)

	journeys := learning.Group("/journeys")
	journeys.Get("/", journeyHandler.List)
	journeys.Post("/", journeyHandler.Create)
	journeys.Put("/:id", journeyHandler.Update)
	journeys.Delete("/:id", journeyHandler.Delete)

	mentors := learning.Group("/mentors")
	mentors.Get("/", mentorHandler.List)
	mentors.Post("/", mentorHandler.Create)
	mentors.Put("/:id", mentorHandler.Update)
	mentors.Delete("/:id", mentorHandler.Delete)
	mentors.Get("/match", mentorHandler.Match)

	sessions := learning.Group("/mentor-sessions")
	sessions.Get("/", sessionHandler.List)
	sessions.Post("/", sessionHandler.Create)
	sessions.Put("/:id", sessionHandler.Update)

	marketplace := learning.Group("/marketplace")
	marketplace.Get("/", marketplaceHandler.List)
	marketplace.Post("/", marketplaceHandler.Create)
	marketplace.Put("/:id", marketplaceHandler.Update)
	marketplace.Delete("/:id", marketplaceHandler.Delete)

	knowledge := learning.Group("/knowledge")
	knowledge.Get("/", knowledgeHandler.List)
	knowledge.Get("/:id", knowledgeHandler.Get)
	knowledge.Post("/", knowledgeHandler.Create)
	knowledge.Put("/:id", knowledgeHandler.Update)
	knowledge.Delete("/:id", knowledgeHandler.Delete)
	knowledge.Post("/:id/useful", knowledgeHandler.MarkUseful)

	analytics := learning.Group("/analytics")
	analytics.Get("/overview", analyticsHandler.Overview)
	analytics.Get("/departments", analyticsHandler.Department)
	analytics.Get("/trends", analyticsHandler.Trends)
	analytics.Get("/competency-matrix", analyticsHandler.CompetencyMatrix)

	endorsements := learning.Group("/endorsements")
	endorsements.Get("/", endorsementHandler.List)
	endorsements.Post("/", endorsementHandler.Create)
	endorsements.Delete("/:id", endorsementHandler.Delete)
}
