## Description

Centralizes URL credential sanitization into the shared atlas-observability library and applies it to all Python services.

## Changes

- Added `sanitize_url()` function to `atlas_observability/shared.py` that redacts passwords from connection URLs before logging
- The function handles all URL schemes (mongodb, postgresql, amqp, http, etc.)
- Exported `sanitize_url` from atlas_observability for use across all Python services
- Updated employee-python-service to use the shared function instead of its local `sanitize_mongo_url`
- Other Python services can now import and use `sanitize_url` from atlas_observability

## Security

Previously, only the employee service had credential redaction via a local function. Now any Python service can sanitize connection URLs before logging them, preventing accidental credential exposure in logs.

Fixes #25
