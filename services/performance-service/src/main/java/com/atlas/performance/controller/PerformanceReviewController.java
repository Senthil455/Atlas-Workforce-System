package com.atlas.performance.controller;

import com.atlas.performance.model.PerformanceReview;
import com.atlas.common.security.RequiresRole;
import com.atlas.common.security.TenantId;
import com.atlas.performance.service.PerformanceService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/reviews")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
public class PerformanceReviewController {

    private final PerformanceService service;

    public PerformanceReviewController(PerformanceService service) {
        this.service = service;
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping
    public ResponseEntity<List<PerformanceReview>> listReviews(
            @TenantId String tenantId,
            @RequestParam(required = false) String employeeId,
            @RequestParam(required = false) String reviewerId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String cycle) {
        return ResponseEntity.ok(service.getReviews(tenantId, employeeId, reviewerId, status, cycle));
    }

    @RequiresRole({"admin", "hr", "manager"})
    @PostMapping
    public ResponseEntity<?> createReview(
            @RequestBody PerformanceReview review,
            @TenantId String tenantId) {
        try {
            return ResponseEntity.ok(service.createReview(tenantId, review));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/{id}")
    public ResponseEntity<?> getReview(
            @PathVariable String id,
            @TenantId String tenantId) {
        try {
            return ResponseEntity.ok(service.getReview(tenantId, id));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager"})
    @PutMapping("/{id}")
    public ResponseEntity<?> updateReview(
            @PathVariable String id,
            @RequestBody PerformanceReview review,
            @TenantId String tenantId) {
        try {
            return ResponseEntity.ok(service.updateReview(tenantId, id, review));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager"})
    @PutMapping("/{id}/submit")
    public ResponseEntity<?> submitReview(
            @PathVariable String id,
            @TenantId String tenantId) {
        try {
            return ResponseEntity.ok(service.submitReview(tenantId, id));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @PutMapping("/{id}/acknowledge")
    public ResponseEntity<?> acknowledgeReview(
            @PathVariable String id,
            @TenantId String tenantId) {
        try {
            return ResponseEntity.ok(service.acknowledgeReview(tenantId, id));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/cycle/{cycle}")
    public ResponseEntity<List<PerformanceReview>> getReviewsByCycle(
            @PathVariable String cycle,
            @TenantId String tenantId) {
        return ResponseEntity.ok(service.getReviewsByCycle(tenantId, cycle));
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/employee/{employeeId}")
    public ResponseEntity<List<PerformanceReview>> getReviewHistory(
            @PathVariable String employeeId,
            @TenantId String tenantId) {
        return ResponseEntity.ok(service.getReviewHistory(tenantId, employeeId));
    }
}
