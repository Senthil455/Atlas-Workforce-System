## Description

Consolidates the duplicated @RequiresRole annotation and RoleAspect AOP interceptor from all three Java services into the shared atlas-common library. All three copies were 100% identical except for the package name.

## Changes

- Created shared `RequiresRole` annotation in `com.atlas.common.security` package within atlas-common
- Created shared `RoleAspect` AOP interceptor in the same package
- Added `spring-boot-starter-aop` dependency to atlas-common's pom.xml
- Updated `CommonSecurityAutoConfiguration` to component-scan the full security package
- Deleted 3 identical copies from payroll-java-service, performance-service, and leave-service
- Updated all controller imports across all 3 services to reference `com.atlas.common.security.RequiresRole`

## Benefits

- Eliminates 100% code duplication of RBAC infrastructure
- Single source of truth for role-checking logic
- Adding RBAC to new Java services requires only depending on atlas-common
- Maintenance changes apply to all services at once

## Testing

All controller endpoints retain their existing @RequiresRole annotations. The shared RoleAspect behaves identically to the deleted copies since it is the same code.

Fixes #23
