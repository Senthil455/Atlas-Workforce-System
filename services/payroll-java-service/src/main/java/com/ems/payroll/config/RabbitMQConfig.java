package com.ems.payroll.config;

import org.springframework.amqp.core.*;
import org.springframework.amqp.rabbit.config.SimpleRabbitListenerContainerFactory;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RabbitMQConfig {

    @Value("${payroll.exchange.name}")
    private String exchangeName;

    @Value("${payroll.processed.queue}")
    private String processedQueue;

    @Value("${payroll.compensation.queue}")
    private String compensationQueue;

    @Value("${payroll.dlq.name}")
    private String dlqName;

    @Bean
    public TopicExchange payrollExchange() {
        return new TopicExchange(exchangeName, true, false);
    }

    @Bean
    public Queue processedQueue() {
        return new Queue(processedQueue, true);
    }

    @Bean
    public Queue compensationQueue() {
        return new Queue(compensationQueue, true);
    }

    @Bean
    public Queue dlqQueue() {
        return new Queue(dlqName, true);
    }

    @Bean
    public Binding processedBinding() {
        return BindingBuilder.bind(processedQueue())
                .to(payrollExchange())
                .with("payroll.processed.*");
    }

    @Bean
    public Binding compensationBinding() {
        return BindingBuilder.bind(compensationQueue())
                .to(payrollExchange())
                .with("payroll.compensation.*");
    }

    @Bean
    public Binding dlqBinding() {
        return BindingBuilder.bind(dlqQueue())
                .to(payrollExchange())
                .with("payroll.dlq.*");
    }

    @Bean
    public MessageConverter messageConverter() {
        return new Jackson2JsonMessageConverter();
    }

    @Bean
    public RabbitTemplate rabbitTemplate(ConnectionFactory connectionFactory) {
        RabbitTemplate rabbitTemplate = new RabbitTemplate(connectionFactory);
        rabbitTemplate.setMessageConverter(messageConverter());
        return rabbitTemplate;
    }

    @Bean
    public SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(ConnectionFactory connectionFactory) {
        SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
        factory.setConnectionFactory(connectionFactory);
        factory.setMessageConverter(messageConverter());
        return factory;
    }
}
