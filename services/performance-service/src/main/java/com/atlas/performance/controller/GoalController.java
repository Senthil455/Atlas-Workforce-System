package com.atlas.performance.controller;

import com.atlas.performance.model.Goal;
import com.atlas.common.security.RequiresRole;
import com.atlas.performance.service.PerformanceService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/goals")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
public class GoalController {

    private final PerformanceService service;

    public GoalController(PerformanceService service) {
        this.service = service;
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping
    public ResponseEntity<List<Goal>> listGoals(
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId,
            @RequestParam(required = false) String employeeId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String category) {
        return ResponseEntity.ok(service.getGoals(tenantId, employeeId, status, category));
    }

    @RequiresRole({"admin", "hr", "manager"})
    @PostMapping
    public ResponseEntity<?> createGoal(
            @RequestBody Goal goal,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.createGoal(tenantId, goal));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/{id}")
    public ResponseEntity<?> getGoal(
            @PathVariable String id,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.getGoal(tenantId, id));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager"})
    @PutMapping("/{id}")
    public ResponseEntity<?> updateGoal(
            @PathVariable String id,
            @RequestBody Goal goal,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.updateGoal(tenantId, id, goal));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr"})
    @DeleteMapping("/{id}")
    public ResponseEntity<?> deleteGoal(
            @PathVariable String id,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            service.deleteGoal(tenantId, id);
            return ResponseEntity.ok(Map.of("message", "Goal deleted successfully"));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @PutMapping("/{id}/progress")
    public ResponseEntity<?> updateProgress(
            @PathVariable String id,
            @RequestBody Map<String, Object> request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            BigDecimal progressPct = request.containsKey("progressPct")
                    ? new BigDecimal(request.get("progressPct").toString()) : null;
            String keyResults = (String) request.get("keyResults");
            return ResponseEntity.ok(service.updateGoalProgress(tenantId, id, progressPct, keyResults));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager"})
    @PutMapping("/{id}/status")
    public ResponseEntity<?> updateStatus(
            @PathVariable String id,
            @RequestBody Map<String, String> request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.updateGoalStatus(tenantId, id, request.get("status")));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }
}
