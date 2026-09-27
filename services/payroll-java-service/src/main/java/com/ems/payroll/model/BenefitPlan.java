package com.ems.payroll.model;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
@Table(name = "benefit_plans")
public class BenefitPlan {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String tenantId;
    private String name;
    private String type;
    private String description;
    @Column(precision = 19, scale = 2)
    private BigDecimal employerContribution;
    @Column(precision = 19, scale = 2)
    private BigDecimal employeeContribution;
    @Column(precision = 19, scale = 2)
    private BigDecimal maxBenefitAmount;
    private Integer maxParticipants;
    private Integer currentParticipants;
    private Boolean isActive;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    @Version
    private Integer version;

    public BenefitPlan() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getType() { return type; }
    public void setType(String type) { this.type = type; }
    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }
    public BigDecimal getEmployerContribution() { return employerContribution; }
    public void setEmployerContribution(BigDecimal employerContribution) { this.employerContribution = employerContribution; }
    public BigDecimal getEmployeeContribution() { return employeeContribution; }
    public void setEmployeeContribution(BigDecimal employeeContribution) { this.employeeContribution = employeeContribution; }
    public BigDecimal getMaxBenefitAmount() { return maxBenefitAmount; }
    public void setMaxBenefitAmount(BigDecimal maxBenefitAmount) { this.maxBenefitAmount = maxBenefitAmount; }
    public Integer getMaxParticipants() { return maxParticipants; }
    public void setMaxParticipants(Integer maxParticipants) { this.maxParticipants = maxParticipants; }
    public Integer getCurrentParticipants() { return currentParticipants; }
    public void setCurrentParticipants(Integer currentParticipants) { this.currentParticipants = currentParticipants; }
    public Boolean getIsActive() { return isActive; }
    public void setIsActive(Boolean isActive) { this.isActive = isActive; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
    public Integer getVersion() { return version; }
    public void setVersion(Integer version) { this.version = version; }
}
