package com.atlas.performance.controller;

import com.atlas.performance.model.Recognition;
import com.atlas.common.security.RequiresRole;
import com.atlas.performance.service.PerformanceService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/recognitions")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
public class RecognitionController {

    private final PerformanceService service;

    public RecognitionController(PerformanceService service) {
        this.service = service;
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping
    public ResponseEntity<List<Recognition>> listRecognitions(
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId,
            @RequestParam(required = false) String employeeId,
            @RequestParam(required = false) String category) {
        return ResponseEntity.ok(service.getRecognitions(tenantId, employeeId, category));
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @PostMapping
    public ResponseEntity<?> giveRecognition(
            @RequestBody Recognition recognition,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            return ResponseEntity.ok(service.giveRecognition(tenantId, recognition));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        }
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/wall")
    public ResponseEntity<List<Recognition>> getRecognitionWall(
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        return ResponseEntity.ok(service.getRecognitionWall(tenantId));
    }
}
