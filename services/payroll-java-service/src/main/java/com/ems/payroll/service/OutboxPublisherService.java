package com.ems.payroll.service;

import com.ems.payroll.model.OutboxEvent;
import com.ems.payroll.repository.OutboxEventRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

@Service
public class OutboxPublisherService {

    private static final Logger log = LoggerFactory.getLogger(OutboxPublisherService.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};

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
                Map<String, Object> payloadMap = deserializePayload(event.getPayload());
                rabbitTemplate.convertAndSend(exchangeName, routingKey, payloadMap);
                event.setStatus("SENT");
                event.setProcessedAt(LocalDateTime.now());
                outboxEventRepository.save(event);
                log.debug("Published outbox event {} type={} routingKey={}", event.getId(), event.getEventType(), routingKey);
            } catch (Exception e) {
                log.error("Failed to publish outbox event {} type={}: {}", event.getId(), event.getEventType(), e.getMessage(), e);
                event.setRetryCount(event.getRetryCount() + 1);
                if (event.getRetryCount() >= maxRetries) {
                    event.setStatus("FAILED");
                    try {
                        Map<String, Object> dlqPayload = deserializePayload(event.getPayload());
                        rabbitTemplate.convertAndSend(exchangeName, "payroll.dlq.failed", dlqPayload);
                    } catch (Exception dlqEx) {
                        log.warn("Failed to publish DLQ for event {}: {}", event.getId(), dlqEx.getMessage());
                    }
                }
                outboxEventRepository.save(event);
            }
        }
    }

    private Map<String, Object> deserializePayload(String payload) {
        try {
            if (payload == null || payload.isBlank()) {
                return Map.of();
            }
            return MAPPER.readValue(payload, MAP_TYPE);
        } catch (Exception ex) {
            throw new IllegalStateException("Invalid JSON payload: " + ex.getMessage(), ex);
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
