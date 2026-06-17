package com.ems.payroll.service;

import com.ems.payroll.model.EnhancedPayrollRecord;
import com.ems.payroll.model.OutboxEvent;
import com.ems.payroll.model.PayrollAudit;
import com.ems.payroll.repository.EnhancedPayrollRepository;
import com.ems.payroll.repository.OutboxEventRepository;
import com.ems.payroll.repository.PayrollAuditRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class PayrollCompensationService {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final EnhancedPayrollRepository payrollRepo;
    private final OutboxEventRepository outboxEventRepository;
    private final PayrollAuditRepository auditRepo;

    public PayrollCompensationService(EnhancedPayrollRepository payrollRepo,
                                       OutboxEventRepository outboxEventRepository,
                                       PayrollAuditRepository auditRepo) {
        this.payrollRepo = payrollRepo;
        this.outboxEventRepository = outboxEventRepository;
        this.auditRepo = auditRepo;
    }

    @Transactional
    public void compensatePayroll(String payrollId, String reason) {
        Long id = Long.valueOf(payrollId);
        EnhancedPayrollRecord record = payrollRepo.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("Payroll record not found: " + payrollId));

        record.setStatus("COMPENSATED");
        payrollRepo.save(record);

        PayrollAudit audit = new PayrollAudit();
        audit.setTenantId(record.getTenantId());
        audit.setPayrollId(record.getId());
        audit.setAction("PAYROLL_COMPENSATED");
        audit.setChangedBy("system");
        audit.setOldValue("PROCESSED");
        audit.setNewValue("COMPENSATED");
        audit.setChangedAt(LocalDateTime.now());
        auditRepo.save(audit);

        OutboxEvent compensationEvent = new OutboxEvent();
        compensationEvent.setAggregateType("payroll");
        compensationEvent.setAggregateId(payrollId);
        compensationEvent.setEventType("PAYROLL_COMPENSATED");
        compensationEvent.setPayload(toJson(Map.of("payrollId", payrollId, "reason", reason)));
        compensationEvent.setStatus("PENDING");
        compensationEvent.setRetryCount(0);
        compensationEvent.setCreatedAt(LocalDateTime.now());
        outboxEventRepository.save(compensationEvent);
    }

    @Transactional
    public void handlePayrollFailure(String payrollId, String errorMessage) {
        OutboxEvent failureEvent = new OutboxEvent();
        failureEvent.setAggregateType("payroll");
        failureEvent.setAggregateId(payrollId);
        failureEvent.setEventType("PAYROLL_FAILED");
        failureEvent.setPayload(toJson(Map.of("payrollId", payrollId, "error", errorMessage)));
        failureEvent.setStatus("PENDING");
        failureEvent.setRetryCount(0);
        failureEvent.setCreatedAt(LocalDateTime.now());
        outboxEventRepository.save(failureEvent);
    }

    private static String toJson(Map<String, Object> payload) {
        try {
            return MAPPER.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to serialize outbox payload", e);
        }
    }
}
