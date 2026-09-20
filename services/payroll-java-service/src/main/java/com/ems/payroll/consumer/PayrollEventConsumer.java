package com.ems.payroll.consumer;

import com.ems.payroll.service.PayrollCompensationService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class PayrollEventConsumer {

    private static final Logger log = LoggerFactory.getLogger(PayrollEventConsumer.class);

    private final PayrollCompensationService compensationService;

    public PayrollEventConsumer(PayrollCompensationService compensationService) {
        this.compensationService = compensationService;
    }

    @RabbitListener(queues = "${payroll.compensation.queue}")
    public void handleCompensationEvent(Map<String, Object> message) {
        try {
            String payrollId = (String) message.get("payrollId");
            if (payrollId == null || payrollId.isBlank()) {
                log.error("Compensation event missing payrollId: {}", message);
                return;
            }
            String reason = (String) message.getOrDefault("reason", "Compensation triggered");
            log.info("Handling compensation for payroll {} reason={}", payrollId, reason);
            compensationService.compensatePayroll(payrollId, reason);
        } catch (Exception e) {
            log.error("Failed to handle compensation event {}: {}", message, e.getMessage(), e);
            throw e;
        }
    }
}
