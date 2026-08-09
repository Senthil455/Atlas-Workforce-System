package com.atlas.common.security;

import jakarta.servlet.http.HttpServletRequest;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.servlet.HandlerMapping;

import java.util.Map;

@Aspect
@Component
public class RoleAspect {

    private static final String EMPLOYEE_ROLE = "employee";

    @Around("@annotation(requiresRole)")
    public Object checkRole(ProceedingJoinPoint joinPoint, RequiresRole requiresRole) throws Throwable {
        ServletRequestAttributes attrs = (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        if (attrs == null) {
            return ResponseEntity.status(500).body(Map.of("error", "No request context"));
        }

        HttpServletRequest request = attrs.getRequest();
        String userRole = (String) request.getAttribute("x-user-role");

        if (userRole == null || userRole.isBlank()) {
            return ResponseEntity.status(403).body(Map.of("error", "Access denied: no role assigned"));
        }

        String[] allowedRoles = requiresRole.value();
        if (allowedRoles.length == 0) {
            return joinPoint.proceed();
        }

        for (String role : allowedRoles) {
            if (userRole.equalsIgnoreCase(role)) {
                if (userRole.equalsIgnoreCase(EMPLOYEE_ROLE)
                        && !verifySelfScoped(joinPoint, request)) {
                    return ResponseEntity.status(403).body(Map.of(
                            "error", "Forbidden: employees can only access their own records"));
                }
                return joinPoint.proceed();
            }
        }

        return ResponseEntity.status(403).body(Map.of("error", "Access denied: requires one of roles: " + String.join(", ", allowedRoles)));
    }

    /**
     * Object-level authorization (BOLA/IDOR) guard for the employee role.
     * When an employee role request carries an {@code employeeId} (path
     * variable, query parameter or request body), the value must match the
     * authenticated user id recorded by {@link InternalAuthFilter} as the
     * {@code x-user-id} request attribute. Requests without an
     * {@code employeeId} (aggregate/catalog endpoints) are left unchanged.
     */
    private boolean verifySelfScoped(ProceedingJoinPoint joinPoint, HttpServletRequest request) {
        String userId = (String) request.getAttribute("x-user-id");
        if (userId == null || userId.isBlank()) {
            return false;
        }

        String requestedEmployeeId = resolveEmployeeId(joinPoint, request);
        return requestedEmployeeId == null
                || requestedEmployeeId.isBlank()
                || userId.equals(requestedEmployeeId);
    }

    private String resolveEmployeeId(ProceedingJoinPoint joinPoint, HttpServletRequest request) {
        @SuppressWarnings("unchecked")
        Map<String, String> uriVariables = (Map<String, String>) request.getAttribute(
                HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE);
        if (uriVariables != null) {
            String pathParam = uriVariables.get("employeeId");
            if (pathParam != null && !pathParam.isBlank()) {
                return pathParam;
            }
        }

        String queryParam = request.getParameter("employeeId");
        if (queryParam != null && !queryParam.isBlank()) {
            return queryParam;
        }

        for (Object arg : joinPoint.getArgs()) {
            if (arg instanceof Map<?, ?>) {
                Object bodyEmployeeId = ((Map<?, ?>) arg).get("employeeId");
                if (bodyEmployeeId != null && !bodyEmployeeId.toString().isBlank()) {
                    return bodyEmployeeId.toString();
                }
            }
        }
        return null;
    }
}
