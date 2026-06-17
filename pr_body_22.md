## Description

Adds explicit JWT expiration (exp) claim validation to all three Go services after the existing jwt.ParseWithClaims call. While the golang-jwt v5 library's RegisteredClaims struct already validates exp during parsing, this check provides defense-in-depth and returns clearer error messages for expired tokens.

## Changes

- services/attendance-service/auth.go: Added explicit exp check in authMiddleware after claims type assertion
- services/lms-service/middleware/auth.go: Same exp check in the AuthMiddleware
- services/notification-go-service/main.go: Added exp check in both validateJWT (WebSocket tokens) and internalAuthMiddleware (REST API tokens)

## Testing

- All existing JWT validation continues to work as before
- Expired tokens now return a specific "Token has expired" error message instead of a generic error
- No breaking changes to valid token flows

Fixes #22
