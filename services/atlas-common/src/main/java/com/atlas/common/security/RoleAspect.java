package com.atlas.common.security;

import jakarta.servlet.http.HttpServletRequest;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.util.Map;

@Aspect
@Component
public class RoleAspect {

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
                return joinPoint.proceed();
            }
        }

        return ResponseEntity.status(403).body(Map.of("error", "Access denied: requires one of roles: " + String.join(", ", allowedRoles)));
    }
}
