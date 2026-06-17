package com.ems.payroll;

import com.ems.payroll.model.OutboxEvent;
import com.ems.payroll.repository.OutboxEventRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

@Service
public class PayrollService {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final PayrollRepository repository;
    private final OutboxEventRepository outboxEventRepository;

    public PayrollService(PayrollRepository repository, OutboxEventRepository outboxEventRepository) {
        this.repository = repository;
        this.outboxEventRepository = outboxEventRepository;
    }

    public List<PayrollRecord> getAllPayrolls(String tenantId) {
        return repository.findByTenantId(tenantId);
    }

    public List<PayrollRecord> getPayrollsByEmployeeId(String tenantId, String employeeId) {
        return repository.findByTenantIdAndEmployeeId(tenantId, employeeId);
    }

    @Transactional
    public PayrollRecord runPayroll(String tenantId, String employeeId, String period, Double baseSalary, Double allowances, Double deductions) {
        try {
            // Check if payroll already exists for this period
            List<PayrollRecord> existing = repository.findByTenantIdAndEmployeeIdAndPeriod(tenantId, employeeId, period);
            if (!existing.isEmpty()) {
                throw new IllegalArgumentException("Payroll already processed for this period");
            }

            double grossSalary = baseSalary + allowances - deductions;
            double tax = calculateTax(grossSalary);
            double netSalary = grossSalary - tax;

            PayrollRecord record = new PayrollRecord();
            record.setTenantId(tenantId);
            record.setEmployeeId(employeeId);
            record.setPeriod(period);
            record.setBaseSalary(baseSalary);
            record.setAllowances(allowances);
            record.setDeductions(deductions);
            record.setTax(tax);
            record.setNetSalary(netSalary);
            record.setStatus("PROCESSED");
            record.setProcessedDate(LocalDateTime.now());

            record = repository.save(record);

            OutboxEvent outboxEvent = new OutboxEvent();
            outboxEvent.setAggregateType("payroll");
            outboxEvent.setAggregateId(String.valueOf(record.getId()));
            outboxEvent.setEventType("PAYROLL_PROCESSED");
            outboxEvent.setPayload(toJson(Map.of(
                "payrollId", record.getId(),
                "employeeId", employeeId,
                "period", period,
                "grossAmount", grossSalary,
                "netAmount", netSalary,
                "currency", "USD",
                "status", "PROCESSED",
                "timestamp", LocalDateTime.now().toString(),
                "tenantId", tenantId
            )));
            outboxEvent.setStatus("PENDING");
            outboxEvent.setRetryCount(0);
            outboxEvent.setCreatedAt(LocalDateTime.now());
            outboxEventRepository.save(outboxEvent);

            return record;
        } catch (Exception e) {
            OutboxEvent outboxEvent = new OutboxEvent();
            outboxEvent.setAggregateType("payroll");
            outboxEvent.setAggregateId("0");
            outboxEvent.setEventType("PAYROLL_FAILED");
            outboxEvent.setPayload(toJson(Map.of(
                "employeeId", employeeId,
                "period", period,
                "error", e.getMessage(),
                "timestamp", LocalDateTime.now().toString(),
                "tenantId", tenantId
            )));
            outboxEvent.setStatus("PENDING");
            outboxEvent.setRetryCount(0);
            outboxEvent.setCreatedAt(LocalDateTime.now());
            outboxEventRepository.save(outboxEvent);
            throw e;
        }
    }

    private double calculateTax(double grossSalary) {
        // Simple progressive tax calculation
        if (grossSalary <= 3000) return 0;
        if (grossSalary <= 7000) return (grossSalary - 3000) * 0.15;
        if (grossSalary <= 12000) return (4000 * 0.15) + ((grossSalary - 7000) * 0.25);
        return (4000 * 0.15) + (5000 * 0.25) + ((grossSalary - 12000) * 0.35);
    }

    private static String toJson(Map<String, Object> payload) {
        try {
            return MAPPER.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to serialize outbox payload", e);
        }
    }
}
