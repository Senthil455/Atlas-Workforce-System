package com.atlas.performance.controller;

import com.atlas.performance.model.SuccessionCandidate;
import com.atlas.performance.model.SuccessionPlan;
import com.atlas.common.security.RequiresRole;
import com.atlas.performance.service.PerformanceService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/succession")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
public class SuccessionController {

    private final PerformanceService service;

    public SuccessionController(PerformanceService service) {
        this.service = service;
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/plans")
    public ResponseEntity<List<SuccessionPlan>> listPlans(
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId,
            @RequestParam(required = false) String department,
            @RequestParam(required = false) String status) {
        return ResponseEntity.ok(service.getSuccessionPlans(tenantId, department, status));
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/plans")
    public ResponseEntity<?> createPlan(
            @RequestBody SuccessionPlan plan,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.createSuccessionPlan(tenantId, plan));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/plans/{id}")
    public ResponseEntity<?> getPlan(
            @PathVariable String id,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.getSuccessionPlanWithCandidates(tenantId, id));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr"})
    @PutMapping("/plans/{id}")
    public ResponseEntity<?> updatePlan(
            @PathVariable String id,
            @RequestBody SuccessionPlan plan,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.updateSuccessionPlan(tenantId, id, plan));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr"})
    @DeleteMapping("/plans/{id}")
    public ResponseEntity<?> deletePlan(
            @PathVariable String id,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            service.deleteSuccessionPlan(tenantId, id);
            return ResponseEntity.ok(Map.of("message", "Succession plan deleted successfully"));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/candidates")
    public ResponseEntity<?> addCandidate(
            @RequestBody SuccessionCandidate candidate,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.addCandidate(tenantId, candidate));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr"})
    @PutMapping("/candidates/{id}")
    public ResponseEntity<?> updateCandidate(
            @PathVariable String id,
            @RequestBody SuccessionCandidate candidate,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.updateCandidate(tenantId, id, candidate));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr"})
    @DeleteMapping("/candidates/{id}")
    public ResponseEntity<?> removeCandidate(
            @PathVariable String id,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            service.removeCandidate(tenantId, id);
            return ResponseEntity.ok(Map.of("message", "Candidate removed successfully"));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/readiness/{employeeId}")
    public ResponseEntity<List<SuccessionCandidate>> getEmployeeReadiness(
            @PathVariable String employeeId,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        return ResponseEntity.ok(service.getEmployeeReadiness(tenantId, employeeId));
    }
}
