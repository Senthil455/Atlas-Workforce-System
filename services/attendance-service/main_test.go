package main

import (
	"fmt"
	"testing"
)

func TestGetEnv(t *testing.T) {
	got := getEnv("NONEXISTENT_KEY", "default-val")
	if got != "default-val" {
		t.Errorf("expected default-val, got %s", got)
	}
}

func TestIsDuplicateKeyError(t *testing.T) {
	err := fmt.Errorf("duplicate key value violates unique constraint")
	if !isDuplicateKeyError(err) {
		t.Error("expected true for duplicate key error")
	}
}
