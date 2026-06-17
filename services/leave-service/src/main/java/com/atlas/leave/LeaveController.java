package com.atlas.leave;

import com.atlas.common.security.RequiresRole;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/leave")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
public class LeaveController {

    private final LeaveService service;

    public LeaveController(LeaveService service) {
        this.service = service;
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping
    public ResponseEntity<List<LeaveRecord>> getAllLeaveRequests(
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        return ResponseEntity.ok(service.getAllLeaveRequests(tenantId));
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/employee/{employeeId}")
    public ResponseEntity<List<LeaveRecord>> getLeaveByEmployee(
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId,
            @PathVariable String employeeId) {
        return ResponseEntity.ok(service.getLeaveByEmployeeId(tenantId, employeeId));
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @PostMapping("/request")
    public ResponseEntity<?> requestLeave(
            @RequestBody Map<String, String> request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        try {
            String employeeId = request.get("employeeId");
            LocalDate startDate = LocalDate.parse(request.get("startDate"));
            LocalDate endDate = LocalDate.parse(request.get("endDate"));
            String leaveType = request.get("leaveType");
            String reason = request.get("reason");

            LeaveRecord record = service.requestLeave(tenantId, employeeId, startDate, endDate, leaveType, reason);
            return ResponseEntity.ok(record);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("message", "Error submitting leave request"));
        }
    }

    @RequiresRole({"admin", "hr", "manager"})
    @PutMapping("/{id}/status")
    public ResponseEntity<?> updateLeaveStatus(
            @PathVariable Long id,
            @RequestBody Map<String, String> request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {

        try {
            String status = request.get("status");
            ServletRequestAttributes attrs = (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
            String userRole = attrs != null ? (String) attrs.getRequest().getAttribute("x-user-role") : "employee";
            LeaveRecord record = service.updateLeaveStatus(tenantId, id, status, userRole);
            return ResponseEntity.ok(record);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("message", "Error updating leave status"));
        }
    }
}
