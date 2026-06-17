package main

import (
	"os"
	"testing"
)

func TestValidateJWT_NoSecret(t *testing.T) {
	os.Unsetenv("JWT_SECRET")
	_, err := validateJWT("some-token")
	if err == nil {
		t.Error("expected error when JWT_SECRET is not set")
	}
}

func TestValidateJWT_InvalidToken(t *testing.T) {
	os.Setenv("JWT_SECRET", "test-secret")
	defer os.Unsetenv("JWT_SECRET")
	_, err := validateJWT("invalid-token")
	if err == nil {
		t.Error("expected error for invalid token")
	}
}
