package main

import (
	"testing"
	"time"
)

func TestParseShiftTime24h(t *testing.T) {
	h, m, err := parseShiftTime("22:00")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h != 22 || m != 0 {
		t.Errorf("expected 22:00, got %d:%d", h, m)
	}
}

func TestParseShiftTime12h(t *testing.T) {
	h, m, err := parseShiftTime("9:00 AM")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h != 9 || m != 0 {
		t.Errorf("expected 9:00, got %d:%d", h, m)
	}
}

func TestParseShiftTimeInvalid(t *testing.T) {
	for _, bad := range []string{"", "abc", "25:00", "9 oclock"} {
		if _, _, err := parseShiftTime(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}

func TestShiftDurationOvernight(t *testing.T) {
	hrs, err := shiftDurationHours("22:00", "06:00")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if hrs != 8 {
		t.Errorf("expected 8h night shift, got %.2f", hrs)
	}
}

func TestShiftDurationDay(t *testing.T) {
	hrs, err := shiftDurationHours("09:00", "17:30")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if hrs != 8.5 {
		t.Errorf("expected 8.5h, got %.2f", hrs)
	}
}

func TestShiftDurationInvalid(t *testing.T) {
	if _, err := shiftDurationHours("09:00", "not-a-time"); err == nil {
		t.Error("expected error for bad end time")
	}
	if _, err := shiftDurationHours("09:00", "09:00"); err == nil {
		t.Error("expected error for zero-length shift")
	}
}

func TestComputeCappedOvertimeUnderCap(t *testing.T) {
	payable, excess := computeCappedOvertime(9.5, 8, 4)
	if payable != 1.5 || excess != 0 {
		t.Errorf("expected (1.5, 0), got (%.2f, %.2f)", payable, excess)
	}
}

func TestComputeCappedOvertimeNoOvertime(t *testing.T) {
	payable, excess := computeCappedOvertime(7.5, 8, 4)
	if payable != 0 || excess != 0 {
		t.Errorf("expected (0, 0), got (%.2f, %.2f)", payable, excess)
	}
}

func TestComputeCappedOvertimeForgottenClockOut(t *testing.T) {
	// 3-day open record: 72h wall clock against an 8h standard day.
	payable, excess := computeCappedOvertime(72, 8, 4)
	if payable != 4 {
		t.Errorf("expected payable capped at 4, got %.2f", payable)
	}
	if excess != 60 {
		t.Errorf("expected excess of 60 held for review, got %.2f", excess)
	}
}

func TestIsExcessiveShift(t *testing.T) {
	if isExcessiveShift(15.9) {
		t.Error("15.9h should not trip the open-record threshold")
	}
	if !isExcessiveShift(16.1) {
		t.Error("16.1h should trip the open-record threshold")
	}
}

func TestDefaultShiftPolicyWithoutDB(t *testing.T) {
	if db != nil {
		t.Skip("db is connected; defaults test needs db == nil")
	}
	p := getShiftPolicy("t", "e", "2026-01-01")
	if p.standardHours != 8 || p.maxOvertime != 4 || p.multiplier != 1 {
		t.Errorf("expected 8/4/1 defaults, got %.2f/%.2f/%.2f", p.standardHours, p.maxOvertime, p.multiplier)
	}
}

func TestOvertimeCapAcrossDSTBoundary(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("tzdata unavailable")
	}
	// Spring-forward Sunday: 24h wall span is only 23h elapsed.
	start := time.Date(2026, 3, 8, 0, 0, 0, 0, loc)
	end := time.Date(2026, 3, 9, 0, 0, 0, 0, loc)
	duration := end.Sub(start).Hours()
	if duration != 23 {
		t.Fatalf("expected 23h elapsed across spring forward, got %.2f", duration)
	}
	payable, excess := computeCappedOvertime(duration, 8, 4)
	if payable != 4 || excess != 11 {
		t.Errorf("expected capped (4, 11) on DST day, got (%.2f, %.2f)", payable, excess)
	}
}

func TestValidateShiftTimes(t *testing.T) {
	if err := validateShiftTimes("22:00", "06:00"); err != nil {
		t.Errorf("night shift should validate: %v", err)
	}
	if err := validateShiftTimes("09:00", "bogus"); err == nil {
		t.Error("expected error for bad end time")
	}
	if err := validateShiftPolicyNumbers(-1, 1.5); err == nil {
		t.Error("expected error for negative maxOvertime")
	}
	if err := validateShiftPolicyNumbers(4, -2); err == nil {
		t.Error("expected error for negative multiplier")
	}
}
