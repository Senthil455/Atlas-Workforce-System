package com.atlas.performance.controller;

import com.atlas.performance.model.Feedback360;
import com.atlas.common.security.RequiresRole;
import com.atlas.common.security.TenantId;
import com.atlas.performance.service.PerformanceService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/feedback")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
public class FeedbackController {

    private final PerformanceService service;

    public FeedbackController(PerformanceService service) {
        this.service = service;
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping
    public ResponseEntity<List<Feedback360>> listFeedback(
            @TenantId String tenantId,
            @RequestParam(required = false) String employeeId,
            @RequestParam(required = false) String reviewerId) {
        return ResponseEntity.ok(service.getFeedbackList(tenantId, employeeId, reviewerId));
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @PostMapping
    public ResponseEntity<?> submitFeedback(
            @RequestBody Feedback360 feedback,
            @TenantId String tenantId) {
        try {
            return ResponseEntity.ok(service.submitFeedback(tenantId, feedback));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/{id}")
    public ResponseEntity<?> getFeedback(
            @PathVariable String id,
            @TenantId String tenantId) {
        try {
            return ResponseEntity.ok(service.getFeedback(tenantId, id));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/employee/{employeeId}/summary")
    public ResponseEntity<Map<String, Object>> getFeedbackSummary(
            @PathVariable String employeeId,
            @TenantId String tenantId) {
        return ResponseEntity.ok(service.getFeedbackSummary(tenantId, employeeId));
    }
}
