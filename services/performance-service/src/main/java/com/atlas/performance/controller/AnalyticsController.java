package com.atlas.performance.controller;

import com.atlas.common.security.RequiresRole;
import com.atlas.common.security.TenantId;
import com.atlas.performance.service.PerformanceService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/v1/analytics")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
public class AnalyticsController {

    private final PerformanceService service;

    public AnalyticsController(PerformanceService service) {
        this.service = service;
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> getOverview(
            @TenantId String tenantId) {
        return ResponseEntity.ok(service.getAnalyticsOverview(tenantId));
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/department-ratings")
    public ResponseEntity<Map<String, Object>> getDepartmentRatings(
            @TenantId String tenantId) {
        return ResponseEntity.ok(service.getDepartmentRatings(tenantId));
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/goal-completion")
    public ResponseEntity<Map<String, Object>> getGoalCompletion(
            @TenantId String tenantId) {
        return ResponseEntity.ok(service.getGoalCompletionRates(tenantId));
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/succession-readiness")
    public ResponseEntity<Map<String, Object>> getSuccessionReadiness(
            @TenantId String tenantId) {
        return ResponseEntity.ok(service.getSuccessionReadiness(tenantId));
    }
}
