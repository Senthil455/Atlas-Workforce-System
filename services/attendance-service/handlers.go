package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

// ============================================================
// CORE ATTENDANCE HANDLERS
// ============================================================

func getEmployeeID(c *fiber.Ctx) string {
	return c.Get("X-Employee-Id")
}

// List attendance records
func listAttendance(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON([]AttendanceRecord{})
	}
	// Best-effort flag for records left open past the threshold (forgotten
	// clock-out). Runs async so reads stay fast; skips already-flagged rows.
	go flagStaleOpenRecords(tenantId)
	var records []AttendanceRecord
	q := db.Where("tenant_id = ?", tenantId).Order("date DESC, clock_in DESC")

	if empID := c.Query("employeeId"); empID != "" {
		q = q.Where("employee_id = ?", empID)
	}
	if status := c.Query("status"); status != "" {
		q = q.Where("status = ?", status)
	}
	if date := c.Query("date"); date != "" {
		q = q.Where("date = ?", date)
	}
	if startDate := c.Query("startDate"); startDate != "" {
		q = q.Where("date >= ?", startDate)
	}
	if endDate := c.Query("endDate"); endDate != "" {
		q = q.Where("date <= ?", endDate)
	}
	q.Find(&records)
	if records == nil {
		records = []AttendanceRecord{}
	}
	return c.JSON(records)
}

// Get single attendance record
func getAttendance(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	id := c.Params("id")
	if db == nil {
		return c.Status(404).JSON(fiber.Map{"error": "Attendance record not found"})
	}
	var record AttendanceRecord
	err := db.Where("id = ? AND tenant_id = ?", id, tenantId).First(&record).Error
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "Attendance record not found"})
	}
	return c.JSON(record)
}

// Get attendance by employee
func getEmployeeAttendance(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	employeeId := c.Params("employeeId")
	if db == nil {
		return c.JSON([]AttendanceRecord{})
	}
	var records []AttendanceRecord
	db.Where("tenant_id = ? AND employee_id = ?", tenantId, employeeId).Order("date DESC").Find(&records)
	if records == nil {
		records = []AttendanceRecord{}
	}
	return c.JSON(records)
}

// ============================================================
// CLOCK IN / OUT WITH GEO + METHOD SUPPORT
// ============================================================

type ClockInReq struct {
	EmployeeID string  `json:"employeeId"`
	LocalDate  string  `json:"localDate"`
	Latitude   *float64 `json:"latitude"`
	Longitude  *float64 `json:"longitude"`
	Method     string  `json:"method"`
	DeviceID   string  `json:"deviceId"`
	QrToken    string  `json:"qrToken"`
	NfcUID     string  `json:"nfcUid"`
	FaceImage  string  `json:"faceImage"`
	BiometricHash string `json:"biometricHash"`
	IsRemote   bool    `json:"isRemote"`
	IsWFH      bool    `json:"isWfh"`
	IpAddress  string  `json:"ipAddress"`
	UserAgent  string  `json:"userAgent"`
}

func clockIn(c *fiber.Ctx) error {
	var req ClockInReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	today := req.LocalDate
	if today == "" {
		today = time.Now().UTC().Format("2006-01-02")
	}
	tenantId := getTenant(c)

	if db == nil {
		return c.JSON(fiber.Map{"status": "Mock clocked in for " + req.EmployeeID})
	}

	// Default method
	method := req.Method
	if method == "" {
		method = "manual"
	}

	// Determine status
	status := "PRESENT"
	if req.IsRemote {
		status = "REMOTE"
	}
	if req.IsWFH {
		status = "WFH"
	}

	// Geo-verification
	var geoVerified bool
	var geoFenceID *uint
	if req.Latitude != nil && req.Longitude != nil {
		if *req.Latitude < -90 || *req.Latitude > 90 {
			return c.Status(400).JSON(fiber.Map{"error": "Latitude must be between -90 and 90"})
		}
		if *req.Longitude < -180 || *req.Longitude > 180 {
			return c.Status(400).JSON(fiber.Map{"error": "Longitude must be between -180 and 180"})
		}
		var fence GeoFence
		fenceErr := db.Where("tenant_id = ? AND is_active = ?", tenantId, true).First(&fence).Error
		if fenceErr == nil {
			dist := haversine(*req.Latitude, *req.Longitude, fence.Latitude, fence.Longitude)
			if dist <= fence.RadiusMeters {
				geoVerified = true
				geoFenceID = &fence.ID
			}
		}
		// Check late arrival
		status = checkLateArrival(tenantId, req.EmployeeID, today, status)
	}

	record := AttendanceRecord{
		TenantID:    tenantId,
		EmployeeID:  req.EmployeeID,
		Date:        today,
		ClockIn:     time.Now().UTC(),
		Status:      status,
		Method:      method,
		Latitude:    req.Latitude,
		Longitude:   req.Longitude,
		GeoVerified: geoVerified,
		GeoFenceID:  geoFenceID,
		DeviceID:    req.DeviceID,
		QrToken:     req.QrToken,
		NfcUID:      req.NfcUID,
		BiometricHash: req.BiometricHash,
		IpAddress:   req.IpAddress,
		UserAgent:   req.UserAgent,
		IsRemote:    req.IsRemote,
		IsWFH:       req.IsWFH,
	}

	// Face verification if image provided
	if req.FaceImage != "" {
		record.FaceVerified = verifyFace(tenantId, req.EmployeeID, req.FaceImage)
	}

	// Atomic clock-in with transaction + pessimistic locking
	tx := db.Begin()

	var existing AttendanceRecord
	err := tx.Set("gorm:query_option", "FOR UPDATE").
		Where("tenant_id = ? AND employee_id = ? AND date = ?", tenantId, req.EmployeeID, today).
		First(&existing).Error
	if err == nil {
		tx.Rollback()
		return c.Status(400).JSON(fiber.Map{"error": "Already clocked in today"})
	}

	if err := tx.Create(&record).Error; err != nil {
		tx.Rollback()
		if isDuplicateKeyError(err) {
			return c.Status(400).JSON(fiber.Map{"error": "Already clocked in today"})
		}
		return c.Status(500).JSON(fiber.Map{"error": "Failed to create attendance record"})
	}

	tx.Commit()

	// Publish clock-in event to live dashboard
	publishEvent("attendance.clockin", tenantId, record)

	// Detect anomalies after clock-in
	go detectAnomaliesAfterClockIn(record)

	return c.JSON(record)
}

type ClockOutReq struct {
	EmployeeID string  `json:"employeeId"`
	LocalDate  string  `json:"localDate"`
	Latitude   *float64 `json:"latitude"`
	Longitude  *float64 `json:"longitude"`
	Method     string  `json:"method"`
}

func clockOut(c *fiber.Ctx) error {
	var req ClockOutReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}

	today := req.LocalDate
	if today == "" {
		today = time.Now().UTC().Format("2006-01-02")
	}
	tenantId := getTenant(c)

	if db == nil {
		return c.JSON(fiber.Map{"status": "Mock clocked out for " + req.EmployeeID})
	}

	// Atomic clock-out with transaction + pessimistic locking
	tx := db.Begin()

	var record AttendanceRecord
	err := tx.Set("gorm:query_option", "FOR UPDATE").
		Where("tenant_id = ? AND employee_id = ? AND date = ?", tenantId, req.EmployeeID, today).
		First(&record).Error
	if err != nil {
		tx.Rollback()
		return c.Status(404).JSON(fiber.Map{"error": "No clock in found for today"})
	}
	if record.ClockOut != nil {
		tx.Rollback()
		return c.Status(400).JSON(fiber.Map{"error": "Already clocked out"})
	}

	now := time.Now().UTC()
	record.ClockOut = &now

	// Overtime is capped at the shift policy maximum. Anything beyond the
	// cap is not payable and is recorded as an anomaly for manager review,
	// so a forgotten clock-out cannot turn into unlimited paid overtime.
	duration := now.Sub(record.ClockIn.UTC()).Hours()
	policy := getShiftPolicy(tenantId, req.EmployeeID, today)
	payable, excess := computeCappedOvertime(duration, policy.standardHours, policy.maxOvertime)
	record.Overtime = payable
	record.OvertimeMultiplier = policy.multiplier
	record.OvertimeCapped = excess > 0

	if req.Method != "" {
		record.Method = req.Method
	}
	if req.Latitude != nil && req.Longitude != nil {
		record.Latitude = req.Latitude
		record.Longitude = req.Longitude
	}

	if err := tx.Save(&record).Error; err != nil {
		tx.Rollback()
		return c.Status(500).JSON(fiber.Map{"error": "Failed to update attendance record"})
	}

	tx.Commit()

	if excess > 0 {
		severity := "medium"
		if excess > 8 {
			severity = "high"
		}
		logAnomaly(tenantId, req.EmployeeID, &record.ID, "overtime_capped", severity,
			fmt.Sprintf("Raw overtime of %.2fh exceeded the %.2fh policy cap; %.2fh held for review instead of payroll", payable+excess, policy.maxOvertime, excess))
	}
	if duration > MaxOpenRecordHours {
		logAnomaly(tenantId, req.EmployeeID, &record.ID, "excessive_shift_length", "high",
			fmt.Sprintf("Shift ran %.2fh without clock-out; manager approval required before payout", math.Round(duration*100)/100))
	}

	// Publish clock-out event to live dashboard
	publishEvent("attendance.clockout", tenantId, record)

	return c.JSON(record)
}

// ============================================================
// GEO-FENCE HANDLERS
// ============================================================

func listGeoFences(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON([]GeoFence{})
	}
	var fences []GeoFence
	db.Where("tenant_id = ?", tenantId).Find(&fences)
	if fences == nil {
		fences = []GeoFence{}
	}
	return c.JSON(fences)
}

func createGeoFence(c *fiber.Ctx) error {
	var fence GeoFence
	if err := c.BodyParser(&fence); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	fence.TenantID = getTenant(c)
	if db != nil {
		db.Create(&fence)
	}
	return c.Status(201).JSON(fence)
}

func updateGeoFence(c *fiber.Ctx) error {
	id := c.Params("id")
	tenantId := getTenant(c)
	var fence GeoFence
	if err := db.Where("id = ? AND tenant_id = ?", id, tenantId).First(&fence).Error; err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "Geo-fence not found"})
	}
	var updates map[string]interface{}
	if err := c.BodyParser(&updates); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	db.Model(&fence).Updates(updates)
	db.First(&fence)
	return c.JSON(fence)
}

func deleteGeoFence(c *fiber.Ctx) error {
	id := c.Params("id")
	tenantId := getTenant(c)
	db.Where("id = ? AND tenant_id = ?", id, tenantId).Delete(&GeoFence{})
	return c.JSON(fiber.Map{"message": "Deleted"})
}

func verifyGeoLocation(c *fiber.Ctx) error {
	var req struct {
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	if req.Latitude < -90 || req.Latitude > 90 {
		return c.Status(400).JSON(fiber.Map{"error": "Latitude must be between -90 and 90"})
	}
	if req.Longitude < -180 || req.Longitude > 180 {
		return c.Status(400).JSON(fiber.Map{"error": "Longitude must be between -180 and 180"})
	}
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON(fiber.Map{"verified": true, "distance": 0})
	}
	var fence GeoFence
	err := db.Where("tenant_id = ? AND is_active = ?", tenantId, true).First(&fence).Error
	if err != nil {
		return c.JSON(fiber.Map{"verified": false, "error": "No active geo-fence"})
	}
	dist := haversine(req.Latitude, req.Longitude, fence.Latitude, fence.Longitude)
	verified := dist <= fence.RadiusMeters
	return c.JSON(fiber.Map{
		"verified":      verified,
		"distance":      math.Round(dist*100) / 100,
		"fenceName":     fence.Name,
		"fenceLatitude": fence.Latitude,
		"fenceLongitude": fence.Longitude,
		"radiusMeters":  fence.RadiusMeters,
	})
}

// ============================================================
// SHIFT HANDLERS
// ============================================================

func listShifts(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON([]Shift{})
	}
	var shifts []Shift
	db.Where("tenant_id = ?", tenantId).Find(&shifts)
	if shifts == nil {
		shifts = []Shift{}
	}
	return c.JSON(shifts)
}

func createShift(c *fiber.Ctx) error {
	var shift Shift
	if err := c.BodyParser(&shift); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	if err := validateShiftTimes(shift.StartTime, shift.EndTime); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	if err := validateShiftPolicyNumbers(shift.MaxOvertime, shift.OvertimeMultiplier); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	shift.TenantID = getTenant(c)
	if db != nil {
		db.Create(&shift)
	}
	return c.Status(201).JSON(shift)
}

// validateShiftTimes rejects unparseable or zero-length shift windows.
func validateShiftTimes(start, end string) error {
	if _, _, err := parseShiftTime(start); err != nil {
		return fmt.Errorf("invalid startTime: %v", err)
	}
	if _, _, err := parseShiftTime(end); err != nil {
		return fmt.Errorf("invalid endTime: %v", err)
	}
	if _, err := shiftDurationHours(start, end); err != nil {
		return err
	}
	return nil
}

func validateShiftPolicyNumbers(maxOT, multiplier float64) error {
	if maxOT < 0 {
		return fmt.Errorf("maxOvertime cannot be negative")
	}
	if multiplier < 0 {
		return fmt.Errorf("overtimeMultiplier cannot be negative")
	}
	return nil
}

// validateShiftUpdateMap checks time/policy fields when they are part of a
// partial shift update. Missing keys are left untouched.
func validateShiftUpdateMap(updates map[string]interface{}) error {
	start, hasStart := updates["startTime"].(string)
	end, hasEnd := updates["endTime"].(string)
	if hasStart && hasEnd {
		if err := validateShiftTimes(start, end); err != nil {
			return err
		}
	} else if hasStart {
		if _, _, err := parseShiftTime(start); err != nil {
			return fmt.Errorf("invalid startTime: %v", err)
		}
	} else if hasEnd {
		if _, _, err := parseShiftTime(end); err != nil {
			return fmt.Errorf("invalid endTime: %v", err)
		}
	}
	if v, ok := updates["maxOvertime"]; ok {
		if f, ok := toFloat(v); ok && f < 0 {
			return fmt.Errorf("maxOvertime cannot be negative")
		}
	}
	if v, ok := updates["overtimeMultiplier"]; ok {
		if f, ok := toFloat(v); ok && f < 0 {
			return fmt.Errorf("overtimeMultiplier cannot be negative")
		}
	}
	return nil
}

func toFloat(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func updateShift(c *fiber.Ctx) error {
	id := c.Params("id")
	tenantId := getTenant(c)
	var shift Shift
	if err := db.Where("id = ? AND tenant_id = ?", id, tenantId).First(&shift).Error; err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "Shift not found"})
	}
	var updates map[string]interface{}
	if err := c.BodyParser(&updates); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	if err := validateShiftUpdateMap(updates); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	db.Model(&shift).Updates(updates)
	db.First(&shift)
	return c.JSON(shift)
}

func deleteShift(c *fiber.Ctx) error {
	id := c.Params("id")
	tenantId := getTenant(c)
	db.Where("id = ? AND tenant_id = ?", id, tenantId).Delete(&Shift{})
	return c.JSON(fiber.Map{"message": "Deleted"})
}

// Employee shift assignment
func assignEmployeeShift(c *fiber.Ctx) error {
	var es EmployeeShift
	if err := c.BodyParser(&es); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	es.TenantID = getTenant(c)
	if db != nil {
		db.Create(&es)
	}
	return c.Status(201).JSON(es)
}

func getEmployeeShift(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	employeeId := c.Params("employeeId")
	if db == nil {
		return c.JSON([]EmployeeShift{})
	}
	var shifts []EmployeeShift
	db.Where("tenant_id = ? AND employee_id = ? AND is_active = ?", tenantId, employeeId, true).
		Preload("Shift").Find(&shifts)
	if shifts == nil {
		shifts = []EmployeeShift{}
	}
	return c.JSON(shifts)
}

// ============================================================
// ROSTER HANDLERS
// ============================================================

func listRosters(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON([]Roster{})
	}
	var rosters []Roster
	q := db.Where("tenant_id = ?", tenantId)
	if date := c.Query("date"); date != "" {
		q = q.Where("date = ?", date)
	}
	if empID := c.Query("employeeId"); empID != "" {
		q = q.Where("employee_id = ?", empID)
	}
	q.Preload("Shift").Find(&rosters)
	if rosters == nil {
		rosters = []Roster{}
	}
	return c.JSON(rosters)
}

func createRoster(c *fiber.Ctx) error {
	var roster Roster
	if err := c.BodyParser(&roster); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	roster.TenantID = getTenant(c)
	if db != nil {
		db.Create(&roster)
	}
	return c.Status(201).JSON(roster)
}

func publishRoster(c *fiber.Ctx) error {
	id := c.Params("id")
	tenantId := getTenant(c)
	db.Where("id = ? AND tenant_id = ?", id, tenantId).First(&Roster{}).Update("is_published", true)
	return c.JSON(fiber.Map{"message": "Published"})
}

func bulkCreateRoster(c *fiber.Ctx) error {
	var req struct {
		EmployeeIDs []string `json:"employeeIds"`
		Date        string   `json:"date"`
		ShiftID     uint     `json:"shiftId"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	tenantId := getTenant(c)
	if db != nil {
		for _, empID := range req.EmployeeIDs {
			roster := Roster{
				TenantID:   tenantId,
				EmployeeID: empID,
				Date:       req.Date,
				ShiftID:    req.ShiftID,
			}
			db.Where("tenant_id = ? AND employee_id = ? AND date = ?", tenantId, empID, req.Date).
				Assign(roster).FirstOrCreate(&roster)
		}
	}
	return c.JSON(fiber.Map{"message": "Roster created for " + fmt.Sprintf("%d employees", len(req.EmployeeIDs))})
}

// ============================================================
// QR ATTENDANCE HANDLERS
// ============================================================

func generateQRToken(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	bytes := make([]byte, 16)
	rand.Read(bytes)
	token := hex.EncodeToString(bytes)

	qr := QRAttendance{
		TenantID:  tenantId,
		Token:     token,
		CreatedBy: getEmployeeID(c),
		ExpiresAt: time.Now().Add(5 * time.Minute),
	}
	if db != nil {
		db.Create(&qr)
	}
	return c.JSON(qr)
}

func validateQRToken(c *fiber.Ctx) error {
	var req struct {
		Token string `json:"token"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	if db == nil {
		return c.JSON(fiber.Map{"valid": true, "token": req.Token})
	}
	var qr QRAttendance
	err := db.Where("token = ? AND is_used = ? AND expires_at > ?", req.Token, false, time.Now()).First(&qr).Error
	if err != nil {
		return c.JSON(fiber.Map{"valid": false, "error": "Invalid or expired QR token"})
	}
	return c.JSON(fiber.Map{"valid": true, "token": qr.Token, "geoFenceId": qr.GeoFenceID})
}

func markQRUsed(c *fiber.Ctx) error {
	var req struct {
		Token string `json:"token"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	if db != nil {
		db.Model(&QRAttendance{}).Where("token = ?", req.Token).Update("is_used", true)
	}
	return c.JSON(fiber.Map{"message": "QR token marked as used"})
}

// ============================================================
// NFC HANDLERS
// ============================================================

func registerNFCCard(c *fiber.Ctx) error {
	var nfc NFCRegistration
	if err := c.BodyParser(&nfc); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	nfc.TenantID = getTenant(c)
	if db != nil {
		var existing NFCRegistration
		if err := db.Where("nfc_uid = ? AND is_active = ?", nfc.NfcUID, true).First(&existing).Error; err == nil {
			return c.Status(400).JSON(fiber.Map{"error": "NFC UID already registered"})
		}
		db.Create(&nfc)
	}
	return c.Status(201).JSON(nfc)
}

func listNFCRegistrations(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON([]NFCRegistration{})
	}
	var nfcs []NFCRegistration
	db.Where("tenant_id = ?", tenantId).Find(&nfcs)
	if nfcs == nil {
		nfcs = []NFCRegistration{}
	}
	return c.JSON(nfcs)
}

func validateNFC(c *fiber.Ctx) error {
	var req struct {
		NfcUID string `json:"nfcUid"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	if db == nil {
		return c.JSON(fiber.Map{"valid": true, "employeeId": "mock"})
	}
	var nfc NFCRegistration
	err := db.Where("nfc_uid = ? AND is_active = ?", req.NfcUID, true).First(&nfc).Error
	if err != nil {
		return c.JSON(fiber.Map{"valid": false, "error": "NFC card not recognized"})
	}
	now := time.Now()
	db.Model(&nfc).Update("last_used_at", &now)
	return c.JSON(fiber.Map{"valid": true, "employeeId": nfc.EmployeeID, "deviceName": nfc.DeviceName})
}

// ============================================================
// FACE RECOGNITION HANDLERS
// ============================================================

func enrollFace(c *fiber.Ctx) error {
	var req struct {
		EmployeeID string `json:"employeeId"`
		ImageURL   string `json:"imageUrl"`
		FaceVector string `json:"faceVector"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	if len(req.FaceVector) < 64 {
		return c.Status(400).JSON(fiber.Map{"error": "FaceVector must be at least 64 characters"})
	}
	if req.ImageURL == "" || (!strings.HasPrefix(req.ImageURL, "http://") && !strings.HasPrefix(req.ImageURL, "https://")) {
		return c.Status(400).JSON(fiber.Map{"error": "ImageURL must be a valid URL (http/https)"})
	}
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON(fiber.Map{"message": "Mock face enrolled"})
	}
	enrollment := FaceEnrollment{
		TenantID:   tenantId,
		EmployeeID: req.EmployeeID,
		FaceVector: req.FaceVector,
		ImageURL:   req.ImageURL,
		IsActive:   true,
	}
	db.Where("tenant_id = ? AND employee_id = ?", tenantId, req.EmployeeID).
		Assign(enrollment).FirstOrCreate(&enrollment)
	return c.JSON(enrollment)
}

func getFaceEnrollment(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	employeeId := c.Params("employeeId")
	if db == nil {
		return c.Status(404).JSON(fiber.Map{"error": "Not found"})
	}
	var enrollment FaceEnrollment
	err := db.Where("tenant_id = ? AND employee_id = ? AND is_active = ?", tenantId, employeeId, true).First(&enrollment).Error
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "Face enrollment not found"})
	}
	return c.JSON(enrollment)
}

func verifyFaceAPI(c *fiber.Ctx) error {
	var req struct {
		EmployeeID string `json:"employeeId"`
		FaceImage  string `json:"faceImage"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	tenantId := getTenant(c)
	verified := verifyFace(tenantId, req.EmployeeID, req.FaceImage)
	return c.JSON(fiber.Map{"verified": verified})
}

// ============================================================
// BIOMETRIC HANDLERS
// ============================================================

func registerBiometric(c *fiber.Ctx) error {
	var device BiometricDevice
	if err := c.BodyParser(&device); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	device.TenantID = getTenant(c)
	if db != nil {
		db.Create(&device)
	}
	return c.Status(201).JSON(device)
}

func listBiometricDevices(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON([]BiometricDevice{})
	}
	var devices []BiometricDevice
	db.Where("tenant_id = ?", tenantId).Find(&devices)
	if devices == nil {
		devices = []BiometricDevice{}
	}
	return c.JSON(devices)
}

func verifyBiometric(c *fiber.Ctx) error {
	var req struct {
		EmployeeID string `json:"employeeId"`
		Hash       string `json:"hash"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	if db == nil {
		return c.JSON(fiber.Map{"verified": true})
	}
	var device BiometricDevice
	err := db.Where("employee_id = ? AND hash = ? AND is_active = ?", req.EmployeeID, req.Hash, true).First(&device).Error
	if err != nil {
		return c.JSON(fiber.Map{"verified": false, "error": "Biometric not matched"})
	}
	now := time.Now()
	db.Model(&device).Update("last_used_at", &now)
	return c.JSON(fiber.Map{"verified": true, "deviceType": device.DeviceType})
}

// ============================================================
// ANOMALY DETECTION HANDLERS
// ============================================================

func listAnomalies(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON([]AnomalyLog{})
	}
	var anomalies []AnomalyLog
	q := db.Where("tenant_id = ?", tenantId)
	if empID := c.Query("employeeId"); empID != "" {
		q = q.Where("employee_id = ?", empID)
	}
	if anType := c.Query("type"); anType != "" {
		q = q.Where("anomaly_type = ?", anType)
	}
	if resolved := c.Query("resolved"); resolved != "" {
		q = q.Where("is_resolved = ?", resolved == "true")
	}
	q.Order("detected_at DESC").Find(&anomalies)
	if anomalies == nil {
		anomalies = []AnomalyLog{}
	}
	return c.JSON(anomalies)
}

func resolveAnomaly(c *fiber.Ctx) error {
	id := c.Params("id")
	tenantId := getTenant(c)
	if db != nil {
		now := time.Now()
		db.Model(&AnomalyLog{}).Where("id = ? AND tenant_id = ?", id, tenantId).
			Updates(map[string]interface{}{"is_resolved": true, "resolved_at": &now})
	}
	return c.JSON(fiber.Map{"message": "Anomaly resolved"})
}

// ============================================================
// WFH / REMOTE TRACKING HANDLERS
// ============================================================

func createWFHEntry(c *fiber.Ctx) error {
	var wfh WFHTracking
	if err := c.BodyParser(&wfh); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	wfh.TenantID = getTenant(c)
	if db != nil {
		db.Create(&wfh)
	}
	return c.Status(201).JSON(wfh)
}

func listWFHEntries(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON([]WFHTracking{})
	}
	var entries []WFHTracking
	q := db.Where("tenant_id = ?", tenantId)
	if empID := c.Query("employeeId"); empID != "" {
		q = q.Where("employee_id = ?", empID)
	}
	if date := c.Query("date"); date != "" {
		q = q.Where("date = ?", date)
	}
	q.Order("date DESC").Find(&entries)
	if entries == nil {
		entries = []WFHTracking{}
	}
	return c.JSON(entries)
}

// ============================================================
// HEATMAP HANDLERS
// ============================================================

func getHeatmapData(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON(fiber.Map{"data": []fiber.Map{}})
	}

	period := c.Query("period", "month")
	var results []struct {
		Date    string
		Status  string
		Count   int
		Overtime float64
	}

	query := db.Table("attendance_records").
		Select("date, status, COUNT(*) as count, COALESCE(SUM(overtime), 0) as overtime").
		Where("tenant_id = ?", tenantId)

	if period == "week" {
		query = query.Where("date >= ?", time.Now().AddDate(0, 0, -7).Format("2006-01-02"))
	} else if period == "month" {
		query = query.Where("date >= ?", time.Now().AddDate(0, -1, 0).Format("2006-01-02"))
	} else if period == "quarter" {
		query = query.Where("date >= ?", time.Now().AddDate(0, -3, 0).Format("2006-01-02"))
	}

	query.Group("date, status").Order("date ASC").Scan(&results)

	// Build heatmap data structure
	type DayData struct {
		Date      string             `json:"date"`
		Statuses  map[string]int     `json:"statuses"`
		Total     int                `json:"total"`
		Overtime  float64            `json:"overtime"`
	}
	var heatmap []DayData
	dateMap := make(map[string]*DayData)

	for _, r := range results {
		if _, ok := dateMap[r.Date]; !ok {
			dateMap[r.Date] = &DayData{
				Date:     r.Date,
				Statuses: make(map[string]int),
			}
		}
		dateMap[r.Date].Statuses[r.Status] = r.Count
		dateMap[r.Date].Total += r.Count
		dateMap[r.Date].Overtime += r.Overtime
	}

	for _, d := range dateMap {
		heatmap = append(heatmap, *d)
	}

	if heatmap == nil {
		heatmap = []DayData{}
	}

	return c.JSON(fiber.Map{"data": heatmap, "period": period})
}

// ============================================================
// PREDICTION / AI HANDLERS
// ============================================================

func predictLateArrival(c *fiber.Ctx) error {
	var req struct {
		EmployeeID string `json:"employeeId"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "Invalid request"})
	}
	tenantId := getTenant(c)

	if db == nil {
		return c.JSON(fiber.Map{"prediction": false, "confidence": 0, "reason": "No data"})
	}

	// Analyze last 30 days pattern
	var recentRecords []AttendanceRecord
	db.Where("tenant_id = ? AND employee_id = ?", tenantId, req.EmployeeID).
		Order("date DESC").Limit(30).Find(&recentRecords)

	lateCount := 0
	avgClockInHour := 0.0
	totalDays := len(recentRecords)

	if totalDays == 0 {
		return c.JSON(fiber.Map{"prediction": false, "confidence": 0, "reason": "Insufficient data"})
	}

	for _, r := range recentRecords {
		if r.Status == "LATE" {
			lateCount++
		}
		avgClockInHour += float64(r.ClockIn.Hour()) + float64(r.ClockIn.Minute())/60.0
	}
	avgClockInHour /= float64(totalDays)

	lateRate := float64(lateCount) / float64(totalDays)
	confidence := lateRate * 100
	if confidence > 100 {
		confidence = 100
	}

	prediction := lateRate > 0.3
	reason := ""
	if prediction {
		reason = fmt.Sprintf("Late arrival rate of %.0f%% over last %d days", lateRate*100, totalDays)
	}

	return c.JSON(fiber.Map{
		"prediction":  prediction,
		"confidence":  math.Round(confidence*100) / 100,
		"lateRate":    math.Round(lateRate*10000) / 100,
		"avgClockIn":  fmt.Sprintf("%.1f", avgClockInHour),
		"totalDays":   totalDays,
		"lateDays":    lateCount,
		"reason":      reason,
	})
}

func attendanceAIInsights(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON(fiber.Map{"insights": []fiber.Map{}})
	}

	var insights []fiber.Map

	// Average clock-in time
	var avgClockIn struct {
		AvgHour float64
	}
	db.Raw("SELECT AVG(EXTRACT(HOUR FROM clock_in) + EXTRACT(MINUTE FROM clock_in)/60.0) as avg_hour FROM attendance_records WHERE tenant_id = ?", tenantId).Scan(&avgClockIn)

	// Late arrival rate
	var totalCount, lateCount int64
	db.Model(&AttendanceRecord{}).Where("tenant_id = ?", tenantId).Count(&totalCount)
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND status = ?", tenantId, "LATE").Count(&lateCount)

	if totalCount > 0 {
		lateRate := float64(lateCount) / float64(totalCount) * 100
		insights = append(insights, fiber.Map{
			"type":        "late_arrival_rate",
			"value":       math.Round(lateRate*100) / 100,
			"description": fmt.Sprintf("%.1f%% of all attendance records are late arrivals", lateRate),
			"severity":    severityLabel(lateRate),
		})
	}

	// Overtime analysis
	var overtimeStats struct {
		AvgOvertime float64
		MaxOvertime float64
		TotalOT     float64
	}
	db.Raw("SELECT COALESCE(AVG(overtime),0) as avg_overtime, COALESCE(MAX(overtime),0) as max_overtime, COALESCE(SUM(overtime),0) as total_ot FROM attendance_records WHERE tenant_id = ? AND overtime > 0", tenantId).Scan(&overtimeStats)

	insights = append(insights, fiber.Map{
		"type":        "overtime_analysis",
		"avgOvertime": math.Round(overtimeStats.AvgOvertime*100) / 100,
		"maxOvertime": overtimeStats.MaxOvertime,
		"totalOvertime": math.Round(overtimeStats.TotalOT*100) / 100,
		"description": fmt.Sprintf("Avg overtime: %.1fh, Max: %.1fh, Total: %.1fh", overtimeStats.AvgOvertime, overtimeStats.MaxOvertime, overtimeStats.TotalOT),
	})

	// Geo-fence compliance
	var geoVerified, totalGeo int64
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND latitude IS NOT NULL", tenantId).Count(&totalGeo)
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND geo_verified = ? AND latitude IS NOT NULL", tenantId, true).Count(&geoVerified)

	if totalGeo > 0 {
		complianceRate := float64(geoVerified) / float64(totalGeo) * 100
		insights = append(insights, fiber.Map{
			"type":        "geo_compliance",
			"value":       math.Round(complianceRate*100) / 100,
			"description": fmt.Sprintf("%.1f%% geo-fence compliance rate", complianceRate),
		})
	}

	// Hybrid/WFH ratio
	var remoteCount, wfhCount int64
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND is_remote = ?", tenantId, true).Count(&remoteCount)
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND is_wfh = ?", tenantId, true).Count(&wfhCount)

	if totalCount > 0 {
		remoteRate := float64(remoteCount) / float64(totalCount) * 100
		wfhRate := float64(wfhCount) / float64(totalCount) * 100
		insights = append(insights, fiber.Map{
			"type":        "hybrid_workforce",
			"remoteRate":  math.Round(remoteRate*100) / 100,
			"wfhRate":     math.Round(wfhRate*100) / 100,
			"description": fmt.Sprintf("Remote: %.1f%%, WFH: %.1f%% of all records", remoteRate, wfhRate),
		})
	}

	// Attendance trend (week-over-week)
	var thisWeek, lastWeek int64
	thisWeekStart := time.Now().AddDate(0, 0, -7).Format("2006-01-02")
	lastWeekStart := time.Now().AddDate(0, 0, -14).Format("2006-01-02")
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND date >= ?", tenantId, thisWeekStart).Count(&thisWeek)
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND date >= ? AND date < ?", tenantId, lastWeekStart, thisWeekStart).Count(&lastWeek)

	if lastWeek > 0 {
		trend := float64(thisWeek-lastWeek) / float64(lastWeek) * 100
		insights = append(insights, fiber.Map{
			"type":        "weekly_trend",
			"value":       math.Round(trend*100) / 100,
			"description": fmt.Sprintf("Attendance is %s %.1f%% week-over-week", trendDirection(trend), math.Abs(trend)),
		})
	}

	if insights == nil {
		insights = []fiber.Map{}
	}

	return c.JSON(fiber.Map{"insights": insights})
}

// ============================================================
// DASHBOARD / SUMMARY
// ============================================================

func getDashboardSummary(c *fiber.Ctx) error {
	tenantId := getTenant(c)
	if db == nil {
		return c.JSON(fiber.Map{
			"presentToday": 0, "lateToday": 0, "absentToday": 0,
			"wfhToday": 0, "remoteToday": 0, "totalToday": 0,
			"avgOvertime": 0, "anomaliesCount": 0,
		})
	}

	today := time.Now().UTC().Format("2006-01-02")

	var presentToday, lateToday, absentToday, wfhToday, remoteToday int64
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND date = ? AND status = ?", tenantId, today, "PRESENT").Count(&presentToday)
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND date = ? AND status = ?", tenantId, today, "LATE").Count(&lateToday)
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND date = ? AND status = ?", tenantId, today, "ABSENT").Count(&absentToday)
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND date = ? AND is_wfh = ?", tenantId, today, true).Count(&wfhToday)
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND date = ? AND is_remote = ?", tenantId, today, true).Count(&remoteToday)

	var avgOT float64
	db.Raw("SELECT COALESCE(AVG(overtime),0) FROM attendance_records WHERE tenant_id = ? AND date = ?", tenantId, today).Scan(&avgOT)

	var anomalyCount int64
	db.Model(&AnomalyLog{}).Where("tenant_id = ? AND is_resolved = ?", tenantId, false).Count(&anomalyCount)

	return c.JSON(fiber.Map{
		"presentToday":   presentToday,
		"lateToday":      lateToday,
		"absentToday":    absentToday,
		"wfhToday":       wfhToday,
		"remoteToday":    remoteToday,
		"totalToday":     presentToday + lateToday + wfhToday + remoteToday,
		"avgOvertime":    math.Round(avgOT*100) / 100,
		"anomaliesCount": anomalyCount,
	})
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

func haversine(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371000
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}

const (
	// DefaultStandardHours applies when no shift policy matches.
	DefaultStandardHours = 8.0
	// DefaultMaxOvertimeHours caps payable overtime per day when the shift
	// policy does not define its own cap.
	DefaultMaxOvertimeHours = 4.0
	// DefaultOvertimeMultiplier applies when the shift policy defines none.
	DefaultOvertimeMultiplier = 1.0
	// MaxOpenRecordHours flags a still-open record as a forgotten clock-out.
	MaxOpenRecordHours = 16.0
)

// shiftPolicy bundles the per-day rules resolved from roster/assignment.
type shiftPolicy struct {
	standardHours float64
	maxOvertime   float64
	multiplier    float64
}

// parseShiftTime accepts "15:04" plus common variants such as "3:04 PM".
func parseShiftTime(s string) (int, int, error) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{"15:04", "15:04:05", "3:04 PM", "3:04PM", "3:04 pm"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Hour(), t.Minute(), nil
		}
	}
	return 0, 0, fmt.Errorf("invalid shift time %q: expected HH:MM (24h)", s)
}

// shiftDurationHours returns the shift length in hours, correctly handling
// shifts that cross midnight (e.g. 22:00 to 06:00 is 8 hours).
func shiftDurationHours(start, end string) (float64, error) {
	sh, sm, err := parseShiftTime(start)
	if err != nil {
		return 0, err
	}
	eh, em, err := parseShiftTime(end)
	if err != nil {
		return 0, err
	}
	mins := (eh*60 + em) - (sh*60 + sm)
	if mins == 0 {
		return 0, fmt.Errorf("zero-length shift %q-%q", start, end)
	}
	if mins < 0 {
		mins += 24 * 60
	}
	return float64(mins) / 60.0, nil
}

// computeCappedOvertime caps payable overtime at maxOvertime. The remainder
// comes back as excess so callers can hold it for review instead of payroll.
func computeCappedOvertime(durationHours, standardHours, maxOvertime float64) (payable, excess float64) {
	if maxOvertime < 0 {
		maxOvertime = 0
	}
	raw := math.Round((durationHours-standardHours)*100) / 100
	if raw <= 0 {
		return 0, 0
	}
	if raw > maxOvertime {
		return maxOvertime, math.Round((raw-maxOvertime)*100) / 100
	}
	return raw, 0
}

// isExcessiveShift reports whether a single open stretch ran past the
// forgotten-clock-out threshold.
func isExcessiveShift(durationHours float64) bool {
	return durationHours > MaxOpenRecordHours
}

func applyShiftPolicy(p *shiftPolicy, s *Shift) {
	if hrs, err := shiftDurationHours(s.StartTime, s.EndTime); err == nil && hrs > 0 {
		p.standardHours = hrs
	}
	if s.MaxOvertime > 0 {
		p.maxOvertime = s.MaxOvertime
	}
	if s.OvertimeMultiplier > 0 {
		p.multiplier = s.OvertimeMultiplier
	}
}

// getShiftPolicy resolves roster first, then the active shift assignment,
// falling back to sane defaults when nothing matches or parses.
func getShiftPolicy(tenantID, employeeID, date string) shiftPolicy {
	p := shiftPolicy{
		standardHours: DefaultStandardHours,
		maxOvertime:   DefaultMaxOvertimeHours,
		multiplier:    DefaultOvertimeMultiplier,
	}
	if db == nil {
		return p
	}
	var roster Roster
	if err := db.Where("tenant_id = ? AND employee_id = ? AND date = ?", tenantID, employeeID, date).
		Preload("Shift").First(&roster).Error; err == nil && roster.Shift.ID != 0 {
		applyShiftPolicy(&p, &roster.Shift)
		return p
	}
	var es EmployeeShift
	if err := db.Where("tenant_id = ? AND employee_id = ? AND is_active = ?", tenantID, employeeID, true).
		Preload("Shift").First(&es).Error; err == nil && es.Shift.ID != 0 {
		applyShiftPolicy(&p, &es.Shift)
	}
	return p
}

func getStandardHours(tenantID, employeeID, date string) float64 {
	return getShiftPolicy(tenantID, employeeID, date).standardHours
}

// logAnomaly records an anomaly unless db is unavailable.
func logAnomaly(tenantID, employeeID string, recordID *uint, anomalyType, severity, description string) {
	if db == nil {
		return
	}
	db.Create(&AnomalyLog{
		TenantID:    tenantID,
		EmployeeID:  employeeID,
		RecordID:    recordID,
		AnomalyType: anomalyType,
		Severity:    severity,
		Description: description,
		DetectedAt:  time.Now().UTC(),
	})
}

// flagStaleOpenRecords marks still-open records past the threshold so a
// forgotten clock-out shows up in the anomaly list instead of silently
// growing. Already-flagged rows are skipped.
func flagStaleOpenRecords(tenantId string) {
	if db == nil {
		return
	}
	cutoff := time.Now().UTC().Add(-MaxOpenRecordHours * time.Hour)
	var stale []AttendanceRecord
	db.Where("tenant_id = ? AND clock_out IS NULL AND clock_in < ?", tenantId, cutoff).Find(&stale)
	for i := range stale {
		r := stale[i]
		var existing int64
		db.Model(&AnomalyLog{}).Where("tenant_id = ? AND record_id = ? AND anomaly_type = ? AND is_resolved = ?",
			tenantId, r.ID, "open_record_exceeded", false).Count(&existing)
		if existing > 0 {
			continue
		}
		openHours := math.Round(time.Now().UTC().Sub(r.ClockIn.UTC()).Hours()*100) / 100
		db.Create(&AnomalyLog{
			TenantID:    tenantId,
			EmployeeID:  r.EmployeeID,
			RecordID:    &r.ID,
			AnomalyType: "open_record_exceeded",
			Severity:    "high",
			Description: fmt.Sprintf("Record open for %.2fh without clock-out; capping applies at clock-out and manager review is required", openHours),
			DetectedAt:  time.Now().UTC(),
		})
	}
}

func checkLateArrival(tenantID, employeeID, date, currentStatus string) string {
	if currentStatus == "REMOTE" || currentStatus == "WFH" {
		return currentStatus
	}
	if db == nil {
		return currentStatus
	}
	var es EmployeeShift
	err := db.Where("tenant_id = ? AND employee_id = ? AND is_active = ?", tenantID, employeeID, true).
		Preload("Shift").First(&es).Error
	if err != nil || es.Shift.ID == 0 {
		return currentStatus
	}
	shift := es.Shift
	startH, startM, err := parseShiftTime(shift.StartTime)
	if err != nil {
		return currentStatus
	}
	now := time.Now().UTC()
	shiftStart := time.Date(now.Year(), now.Month(), now.Day(), startH, startM+shift.GraceMinutes, 0, 0, time.UTC)
	if now.After(shiftStart) {
		return "LATE"
	}
	return currentStatus
}

func verifyFace(tenantID, employeeID, faceImage string) bool {
	if db == nil || faceImage == "" {
		return false
	}
	var enrollment FaceEnrollment
	err := db.Where("tenant_id = ? AND employee_id = ? AND is_active = ?", tenantID, employeeID, true).First(&enrollment).Error
	if err != nil {
		return false
	}
	// Use Levenshtein-like similarity on face vectors (mock for now)
	if enrollment.FaceVector != "" && len(faceImage) > 10 {
		return true
	}
	return false
}

func detectAnomaliesAfterClockIn(record AttendanceRecord) {
	if db == nil {
		return
	}

	tenantId := record.TenantID
	employeeId := record.EmployeeID

	// Check for multiple clock-ins on same day by different methods
	var count int64
	db.Model(&AttendanceRecord{}).Where("tenant_id = ? AND employee_id = ? AND date = ?", tenantId, employeeId, record.Date).Count(&count)
	if count > 1 {
		db.Create(&AnomalyLog{
			TenantID:    tenantId,
			EmployeeID:  employeeId,
			RecordID:    &record.ID,
			AnomalyType: "duplicate_clockin",
			Severity:    "medium",
			Description: fmt.Sprintf("Employee %s has %d clock-in records on %s", employeeId, count, record.Date),
			DetectedAt:  time.Now(),
		})
	}

	// Geo-location anomaly: clocked in far from usual location
	if record.Latitude != nil && record.Longitude != nil {
		var prevRecords []AttendanceRecord
		db.Where("tenant_id = ? AND employee_id = ? AND latitude IS NOT NULL AND id != ?",
			tenantId, employeeId, record.ID).Order("date DESC").Limit(5).Find(&prevRecords)
		if len(prevRecords) > 2 {
			avgLat, avgLon := 0.0, 0.0
			for _, r := range prevRecords {
				if r.Latitude != nil && r.Longitude != nil {
					avgLat += *r.Latitude
					avgLon += *r.Longitude
				}
			}
			avgLat /= float64(len(prevRecords))
			avgLon /= float64(len(prevRecords))
			dist := haversine(*record.Latitude, *record.Longitude, avgLat, avgLon)
			if dist > 50000 { // More than 50km from usual
				db.Create(&AnomalyLog{
					TenantID:    tenantId,
					EmployeeID:  employeeId,
					RecordID:    &record.ID,
					AnomalyType: "location_anomaly",
					Severity:    "high",
					Description: fmt.Sprintf("Employee %s clocked in %.0fm from usual location", employeeId, dist),
					DetectedAt:  time.Now(),
				})
			}
		}
	}

	// Overtime pattern detection
	var recentOTRecords []AttendanceRecord
	db.Where("tenant_id = ? AND employee_id = ? AND overtime > 0", tenantId, employeeId).
		Order("date DESC").Limit(10).Find(&recentOTRecords)
	if len(recentOTRecords) >= 5 {
		db.Create(&AnomalyLog{
			TenantID:    tenantId,
			EmployeeID:  employeeId,
			RecordID:    &record.ID,
			AnomalyType: "frequent_overtime",
			Severity:    "low",
			Description: fmt.Sprintf("Employee %s has worked overtime on %d of last 10 days", employeeId, len(recentOTRecords)),
			DetectedAt:  time.Now(),
		})
	}
}

func severityLabel(rate float64) string {
	if rate < 10 {
		return "low"
	} else if rate < 30 {
		return "medium"
	}
	return "high"
}

func trendDirection(trend float64) string {
	if trend > 0 {
		return "up"
	} else if trend < 0 {
		return "down"
	}
	return "stable"
}

func isDuplicateKeyError(err error) bool {
	return strings.Contains(err.Error(), "duplicate key")
}
