package main

import (
	"time"

	"gorm.io/gorm"
)

// Core attendance record
type AttendanceRecord struct {
	ID            uint       `gorm:"primaryKey" json:"id"`
	EmployeeID    string     `gorm:"index:idx_emp_tenant_date;uniqueIndex:idx_unique_emp_date,not null" json:"employeeId"`
	TenantID      string     `gorm:"index:idx_emp_tenant_date;uniqueIndex:idx_unique_emp_date;default:'default'" json:"tenantId"`
	Date          string     `gorm:"index:idx_emp_tenant_date;uniqueIndex:idx_unique_emp_date;not null" json:"date"`
	ClockIn       time.Time  `json:"clockIn"`
	ClockOut      *time.Time `json:"clockOut"`
	Status        string     `json:"status"`
	Overtime      float64    `json:"overtime"`
	OvertimeCapped bool      `json:"overtimeCapped"`
	OvertimeMultiplier float64 `json:"overtimeMultiplier"`
	Method        string     `json:"method"`
	ShiftID       *uint      `json:"shiftId"`
	Latitude      *float64   `json:"latitude"`
	Longitude     *float64   `json:"longitude"`
	GeoVerified   bool       `json:"geoVerified"`
	GeoFenceID    *uint      `json:"geoFenceId"`
	FaceVerified  bool       `json:"faceVerified"`
	BiometricHash string     `json:"biometricHash,omitempty"`
	NfcUID        string     `json:"nfcUid,omitempty"`
	QrToken       string     `json:"qrToken,omitempty"`
	DeviceID      string     `json:"deviceId,omitempty"`
	IpAddress     string     `json:"ipAddress,omitempty"`
	UserAgent     string     `json:"userAgent,omitempty"`
	IsRemote      bool       `json:"isRemote"`
	IsWFH         bool       `json:"isWfh"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	DeletedAt     gorm.DeletedAt `gorm:"index" json:"-"`
}

// Geo-fence configuration
type GeoFence struct {
	ID          uint    `gorm:"primaryKey" json:"id"`
	TenantID    string  `gorm:"index;default:'default'" json:"tenantId"`
	Name        string  `json:"name"`
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	RadiusMeters float64 `json:"radiusMeters"`
	Address     string  `json:"address"`
	IsActive    bool    `json:"isActive"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Shift definition
type Shift struct {
	ID            uint   `gorm:"primaryKey" json:"id"`
	TenantID      string `gorm:"index;default:'default'" json:"tenantId"`
	Name          string `json:"name"`
	StartTime     string `json:"startTime"`
	EndTime       string `json:"endTime"`
	GraceMinutes  int    `json:"graceMinutes"`
	MaxOvertime   float64 `json:"maxOvertime"`
	OvertimeMultiplier float64 `json:"overtimeMultiplier"`
	IsNightShift  bool   `json:"isNightShift"`
	IsActive      bool   `json:"isActive"`
	DaysOfWeek    string `json:"daysOfWeek"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// Employee shift assignment
type EmployeeShift struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	TenantID   string    `gorm:"index;default:'default'" json:"tenantId"`
	EmployeeID string    `gorm:"index" json:"employeeId"`
	ShiftID    uint      `json:"shiftId"`
	Shift      Shift     `gorm:"foreignKey:ShiftID" json:"shift,omitempty"`
	StartDate  string    `json:"startDate"`
	EndDate    string    `json:"endDate,omitempty"`
	IsActive   bool      `json:"isActive"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// Dynamic roster
type Roster struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	TenantID    string    `gorm:"index;default:'default'" json:"tenantId"`
	EmployeeID  string    `gorm:"index" json:"employeeId"`
	Date        string    `json:"date"`
	ShiftID     uint      `json:"shiftId"`
	Shift       Shift     `gorm:"foreignKey:ShiftID" json:"shift,omitempty"`
	IsPublished bool      `json:"isPublished"`
	Notes       string    `json:"notes,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// QR attendance tokens
type QRAttendance struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	TenantID   string    `gorm:"index;default:'default'" json:"tenantId"`
	Token      string    `gorm:"uniqueIndex" json:"token"`
	GeoFenceID *uint     `json:"geoFenceId"`
	CreatedBy  string    `json:"createdBy"`
	ExpiresAt  time.Time `json:"expiresAt"`
	IsUsed     bool      `json:"isUsed"`
	CreatedAt  time.Time `json:"createdAt"`
}

// Biometric device registration
type BiometricDevice struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	TenantID    string    `gorm:"index;default:'default'" json:"tenantId"`
	EmployeeID  string    `gorm:"index" json:"employeeId"`
	DeviceType  string    `json:"deviceType"`
	DeviceUID   string    `gorm:"uniqueIndex" json:"deviceUid"`
	Hash        string    `json:"-"`
	IsActive    bool      `json:"isActive"`
	LastUsedAt  *time.Time `json:"lastUsedAt"`
	CreatedAt   time.Time `json:"createdAt"`
}

// Face recognition enrollment
type FaceEnrollment struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	TenantID   string    `gorm:"index;default:'default'" json:"tenantId"`
	EmployeeID string    `gorm:"uniqueIndex:idx_face_employee" json:"employeeId"`
	FaceVector string    `json:"-"`
	ImageURL   string    `json:"imageUrl"`
	IsActive   bool      `json:"isActive"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Anomaly detection log
type AnomalyLog struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	TenantID    string    `gorm:"index;default:'default'" json:"tenantId"`
	EmployeeID  string    `gorm:"index" json:"employeeId"`
	RecordID    *uint     `json:"recordId"`
	AnomalyType string    `json:"anomalyType"`
	Severity    string    `json:"severity"`
	Description string    `json:"description"`
	IsResolved  bool      `json:"isResolved"`
	DetectedAt  time.Time `json:"detectedAt"`
	ResolvedAt  *time.Time `json:"resolvedAt"`
}

// WFH / Remote tracking
type WFHTracking struct {
	ID          uint      `gorm:"primaryKey" json:"id"`
	TenantID    string    `gorm:"index;default:'default'" json:"tenantId"`
	EmployeeID  string    `gorm:"index" json:"employeeId"`
	Date        string    `json:"date"`
	IsWFH       bool      `json:"isWfh"`
	IsRemote    bool      `json:"isRemote"`
	Location    string    `json:"location,omitempty"`
	ProductivityScore float64 `json:"productivityScore,omitempty"`
	ApprovedBy  string    `json:"approvedBy,omitempty"`
	Notes       string    `json:"notes,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// NFC device registration
type NFCRegistration struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	TenantID   string    `gorm:"index;default:'default'" json:"tenantId"`
	EmployeeID string    `gorm:"index" json:"employeeId"`
	NfcUID     string    `gorm:"uniqueIndex" json:"nfcUid"`
	DeviceName string    `json:"deviceName"`
	IsActive   bool      `json:"isActive"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	CreatedAt  time.Time `json:"createdAt"`
}

func migrateDB(db *gorm.DB) {
	db.AutoMigrate(
		&AttendanceRecord{},
		&GeoFence{},
		&Shift{},
		&EmployeeShift{},
		&Roster{},
		&QRAttendance{},
		&BiometricDevice{},
		&FaceEnrollment{},
		&AnomalyLog{},
		&WFHTracking{},
		&NFCRegistration{},
	)
}
