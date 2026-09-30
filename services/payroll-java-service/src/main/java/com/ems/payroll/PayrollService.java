package com.ems.payroll;

import com.ems.payroll.model.OutboxEvent;
import com.ems.payroll.repository.OutboxEventRepository;
import com.ems.payroll.util.Money;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
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
    public PayrollRecord runPayroll(String tenantId, String employeeId, String period, BigDecimal baseSalary, BigDecimal allowances, BigDecimal deductions) {
        try {
            // Check if payroll already exists for this period
            List<PayrollRecord> existing = repository.findByTenantIdAndEmployeeIdAndPeriod(tenantId, employeeId, period);
            if (!existing.isEmpty()) {
                throw new IllegalArgumentException("Payroll already processed for this period");
            }

            BigDecimal grossSalary = Money.subtract(Money.add(baseSalary, allowances), deductions);
            BigDecimal tax = calculateTax(grossSalary);
            BigDecimal netSalary = Money.subtract(grossSalary, tax);

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

    public BigDecimal calculateTax(BigDecimal grossSalary) {
        // Simple progressive tax calculation, rounded to cents at each bracket.
        BigDecimal gross = Money.of(grossSalary);
        BigDecimal threeK = new BigDecimal("3000.00");
        BigDecimal sevenK = new BigDecimal("7000.00");
        BigDecimal twelveK = new BigDecimal("12000.00");
        if (gross.compareTo(threeK) <= 0) return Money.zero();
        if (gross.compareTo(sevenK) <= 0) return Money.percentOf(gross.subtract(threeK), 0.15);
        if (gross.compareTo(twelveK) <= 0) {
            return Money.add(
                    Money.percentOf(new BigDecimal("4000.00"), 0.15),
                    Money.percentOf(gross.subtract(sevenK), 0.25));
        }
        return Money.add(
                Money.add(
                        Money.percentOf(new BigDecimal("4000.00"), 0.15),
                        Money.percentOf(new BigDecimal("5000.00"), 0.25)),
                Money.percentOf(gross.subtract(twelveK), 0.35));
    }

    private static String toJson(Map<String, Object> payload) {
        try {
            return MAPPER.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to serialize outbox payload", e);
        }
    }
}
