package com.ems.payroll;

import com.atlas.common.security.RequiresRole;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/payroll")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
@Validated
public class PayrollController {

    private final PayrollService service;

    public PayrollController(PayrollService service) {
        this.service = service;
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping
    public ResponseEntity<List<PayrollRecord>> getAllPayrolls(@RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {
        return ResponseEntity.ok(service.getAllPayrolls(tenantId));
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/employee/{employeeId}")
    public ResponseEntity<List<PayrollRecord>> getPayrollsByEmployee(
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId,
            @PathVariable String employeeId) {
        return ResponseEntity.ok(service.getPayrollsByEmployeeId(tenantId, employeeId));
    }

    @RequiresRole({"admin"})
    @PostMapping("/run")
    public ResponseEntity<?> runPayroll(
            @RequestBody Map<String, Object> request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenantId) {

        try {
            String employeeId = (String) request.get("employeeId");
            String period = (String) request.get("period");
            Double baseSalary = Double.valueOf(request.getOrDefault("baseSalary", "0").toString());
            Double allowances = Double.valueOf(request.getOrDefault("allowances", "0").toString());
            Double deductions = Double.valueOf(request.getOrDefault("deductions", "0").toString());

            PayrollRecord record = service.runPayroll(tenantId, employeeId, period, baseSalary, allowances, deductions);
            return ResponseEntity.ok(record);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("message", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("message", "Error processing payroll"));
        }
    }
}
