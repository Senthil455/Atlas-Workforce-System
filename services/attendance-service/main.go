package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"time"

	"github.com/gofiber/adaptor/v2"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/streadway/amqp"
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
var rabbitChan *amqp.Channel

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

func initDatabase() {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		dsn = fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=5432 sslmode=disable",
			getEnv("POSTGRES_HOST", "postgres"),
			getEnv("POSTGRES_USER", "atlas_user"),
			getEnv("POSTGRES_PASSWORD", "atlas_password"),
			getEnv("POSTGRES_DB", "atlas_db"),
		)
	}
	var err error
	db, err = gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Printf("Warning: Could not connect to database (%v)", err)
		return
	}
	migrateDB(db)
}

func initRabbitMQ() {
	rabbitURL := os.Getenv("RABBITMQ_URL")
	if rabbitURL == "" {
		rabbitURL = "amqp://guest:guest@rabbitmq:5672/"
	}

	conn, err := amqp.Dial(rabbitURL)
	if err != nil {
		log.Printf("Warning: Could not connect to RabbitMQ (%v)", err)
		return
	}

	rabbitChan, err = conn.Channel()
	if err != nil {
		log.Printf("Warning: Could not open RabbitMQ channel (%v)", err)
		return
	}

	err = rabbitChan.ExchangeDeclare(
		"live_exchange",
		"topic",
		true,  // durable
		false, // auto-deleted
		false, // internal
		false, // no-wait
		nil,
	)
	if err != nil {
		log.Printf("Warning: Could not declare live_exchange (%v)", err)
	}
}

func consumeEmployeeDeletions() {
	rabbitURL := os.Getenv("RABBITMQ_URL")
	if rabbitURL == "" {
		rabbitURL = "amqp://guest:guest@rabbitmq:5672/"
	}

	conn, err := amqp.Dial(rabbitURL)
	if err != nil {
		log.Printf("Warning: Could not connect to RabbitMQ for deletion consumer (%v)", err)
		return
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		log.Printf("Warning: Could not open channel for deletion consumer (%v)", err)
		return
	}
	defer ch.Close()

	err = ch.ExchangeDeclare(
		"notifications_exchange",
		"fanout",
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		log.Printf("Warning: Could not declare notifications_exchange (%v)", err)
		return
	}

	q, err := ch.QueueDeclare(
		"",
		false,
		false,
		true,
		false,
		nil,
	)
	if err != nil {
		log.Printf("Warning: Could not declare queue (%v)", err)
		return
	}

	err = ch.QueueBind(
		q.Name,
		"",
		"notifications_exchange",
		false,
		nil,
	)
	if err != nil {
		log.Printf("Warning: Could not bind queue (%v)", err)
		return
	}

	msgs, err := ch.Consume(
		q.Name,
		"",
		true,
		false,
		false,
		false,
		nil,
	)
	if err != nil {
		log.Printf("Warning: Could not start consuming (%v)", err)
		return
	}

	log.Printf("Employee deletion consumer started on notifications_exchange")
	for msg := range msgs {
		var event struct {
			Event    string `json:"event"`
			Email    string `json:"email"`
			TenantID string `json:"tenant_id"`
		}
		if err := json.Unmarshal(msg.Body, &event); err != nil {
			log.Printf("Warning: Could not parse deletion event (%v)", err)
			continue
		}
		if event.Event == "employee.deleted" {
			handleEmployeeDeletion(event.TenantID, event.Email)
		}
	}
}

func handleEmployeeDeletion(tenantID, employeeID string) {
	if db == nil {
		log.Printf("DB not available, skipping archive for employee %s/%s", tenantID, employeeID)
		return
	}
	archivedID := "ARCHIVED_" + employeeID
	models := []interface{}{
		&AttendanceRecord{},
		&EmployeeShift{},
		&Roster{},
		&AnomalyLog{},
		&WFHTracking{},
		&NFCRegistration{},
		&BiometricDevice{},
		&FaceEnrollment{},
	}
	for _, model := range models {
		db.Model(model).
			Where("tenant_id = ? AND employee_id = ?", tenantID, employeeID).
			Update("employee_id", archivedID)
	}
	log.Printf("Archived all records for deleted employee: %s/%s -> %s", tenantID, employeeID, archivedID)
}

func publishEvent(routingKey, tenantID string, record AttendanceRecord) {
	if rabbitChan == nil {
		return
	}

	payload := map[string]interface{}{
		"event":      routingKey,
		"tenant_id":  tenantID,
		"employeeId": record.EmployeeID,
		"date":       record.Date,
		"clockIn":    record.ClockIn.Format(time.RFC3339),
		"status":     record.Status,
		"method":     record.Method,
		"isRemote":   record.IsRemote,
		"isWfh":      record.IsWFH,
		"timestamp":  time.Now().UTC().Format(time.RFC3339),
	}
	if record.ClockOut != nil {
		payload["clockOut"] = record.ClockOut.Format(time.RFC3339)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("Warning: Could not marshal event payload (%v)", err)
		return
	}

	err = rabbitChan.Publish(
		"live_exchange",
		routingKey,
		false,
		false,
		amqp.Publishing{
			ContentType: "application/json",
			Body:        body,
		},
	)
	if err != nil {
		log.Printf("Warning: Could not publish event %s (%v)", routingKey, err)
	}
}

func main() {
	initDatabase()
	initRabbitMQ()
	go consumeEmployeeDeletions()

	app := fiber.New(fiber.Config{
		AppName: "Atlas Attendance Service",
	})

	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowMethods: "GET,POST,PUT,DELETE,OPTIONS",
		AllowHeaders: "Origin,Content-Type,Accept,Authorization,X-Tenant-Id,X-Employee-Id",
	}))

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

	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "Attendance Service is running", "version": "2.0.0"})
	})

	initAuth()
	app.Use(authMiddleware)

	api := app.Group("/api/attendance")

	// ============================================================
	// Core attendance CRUD
	// ============================================================
	api.Get("/", listAttendance)
	api.Get("/:id", getAttendance)
	api.Get("/employee/:employeeId", getEmployeeAttendance)

	// Clock in/out
	api.Post("/clock-in", clockIn)
	api.Post("/clock-out", clockOut)

	// Dashboard
	api.Get("/dashboard/summary", getDashboardSummary)

	// ============================================================
	// Geo-fence management
	// ============================================================
	api.Get("/geo-fences", listGeoFences)
	api.Post("/geo-fences", createGeoFence)
	api.Put("/geo-fences/:id", updateGeoFence)
	api.Delete("/geo-fences/:id", deleteGeoFence)
	api.Post("/geo-fences/verify", verifyGeoLocation)

	// ============================================================
	// Shift management
	// ============================================================
	api.Get("/shifts", listShifts)
	api.Post("/shifts", createShift)
	api.Put("/shifts/:id", updateShift)
	api.Delete("/shifts/:id", deleteShift)

	// Employee shift assignments
	api.Post("/employee-shifts", assignEmployeeShift)
	api.Get("/employee-shifts/:employeeId", getEmployeeShift)

	// ============================================================
	// Dynamic rostering
	// ============================================================
	api.Get("/rosters", listRosters)
	api.Post("/rosters", createRoster)
	api.Post("/rosters/bulk", bulkCreateRoster)
	api.Post("/rosters/:id/publish", publishRoster)

	// ============================================================
	// QR attendance
	// ============================================================
	api.Post("/qr/generate", generateQRToken)
	api.Post("/qr/validate", validateQRToken)
	api.Post("/qr/use", markQRUsed)

	// ============================================================
	// NFC attendance
	// ============================================================
	api.Post("/nfc/register", registerNFCCard)
	api.Get("/nfc/list", listNFCRegistrations)
	api.Post("/nfc/validate", validateNFC)

	// ============================================================
	// Face recognition
	// ============================================================
	api.Post("/face/enroll", enrollFace)
	api.Get("/face/enrollment/:employeeId", getFaceEnrollment)
	api.Post("/face/verify", verifyFaceAPI)

	// ============================================================
	// Biometric integration
	// ============================================================
	api.Post("/biometric/register", registerBiometric)
	api.Get("/biometric/devices", listBiometricDevices)
	api.Post("/biometric/verify", verifyBiometric)

	// ============================================================
	// Anomaly detection
	// ============================================================
	api.Get("/anomalies", listAnomalies)
	api.Post("/anomalies/:id/resolve", resolveAnomaly)

	// ============================================================
	// WFH / Remote tracking
	// ============================================================
	api.Post("/wfh", createWFHEntry)
	api.Get("/wfh", listWFHEntries)

	// ============================================================
	// Heatmap
	// ============================================================
	api.Get("/heatmap", getHeatmapData)

	// ============================================================
	// Predictions & AI insights
	// ============================================================
	api.Post("/predict/late-arrival", predictLateArrival)
	api.Get("/ai/insights", attendanceAIInsights)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8005"
	}

	log.Printf("Atlas Attendance Service v2.0 listening on port %s", port)
	app.Listen(":" + port)
}
