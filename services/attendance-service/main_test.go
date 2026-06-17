package main

import (
	"testing"
)

func TestGetEnv(t *testing.T) {
	got := getEnv("NONEXISTENT_KEY", "default-val")
	if got != "default-val" {
		t.Errorf("expected default-val, got %s", got)
	}
}

func TestIsDuplicateKeyError(t *testing.T) {
	if isDuplicateKeyError(nil) {
		t.Error("expected false for nil error")
	}
}
