package com.ems.payroll.service;

import com.ems.payroll.model.OutboxEvent;
import com.ems.payroll.repository.OutboxEventRepository;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

@Service
public class OutboxPublisherService {

    private final OutboxEventRepository outboxEventRepository;
    private final RabbitTemplate rabbitTemplate;

    @Value("${payroll.exchange.name}")
    private String exchangeName;

    @Value("${outbox.max.retries:5}")
    private int maxRetries;

    public OutboxPublisherService(OutboxEventRepository outboxEventRepository, RabbitTemplate rabbitTemplate) {
        this.outboxEventRepository = outboxEventRepository;
        this.rabbitTemplate = rabbitTemplate;
    }

    @Scheduled(fixedDelayString = "${outbox.poll.interval:5000}")
    @Transactional
    public void publishPendingEvents() {
        List<OutboxEvent> pendingEvents = outboxEventRepository.findPendingEventsWithLock(maxRetries);
        for (OutboxEvent event : pendingEvents) {
            try {
                String routingKey = resolveRoutingKey(event.getEventType());
                rabbitTemplate.convertAndSend(exchangeName, routingKey, event.getPayload());
                event.setStatus("SENT");
                event.setProcessedAt(LocalDateTime.now());
                outboxEventRepository.save(event);
            } catch (Exception e) {
                event.setRetryCount(event.getRetryCount() + 1);
                if (event.getRetryCount() >= maxRetries) {
                    event.setStatus("FAILED");
                    try {
                        rabbitTemplate.convertAndSend(exchangeName, "payroll.dlq.failed", event.getPayload());
                    } catch (Exception dlqEx) {
                        // best-effort DLQ publish
                    }
                }
                outboxEventRepository.save(event);
            }
        }
    }

    private String resolveRoutingKey(String eventType) {
        return switch (eventType) {
            case "PAYROLL_PROCESSED" -> "payroll.processed.processed";
            case "PAYROLL_FAILED" -> "payroll.processed.failed";
            case "PAYROLL_COMPENSATED" -> "payroll.compensation.compensated";
            default -> "payroll.dlq.unknown";
        };
    }
}
