package com.ems.payroll.model;

import jakarta.persistence.*;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.PositiveOrZero;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Entity
@Table(name = "compensation_plans")
public class CompensationPlan {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String employeeId;
    private String tenantId;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal currentBaseSalary;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal proposedBaseSalary;
    private String currency;
    private LocalDate effectiveDate;
    private String reason;
    private String status;
    private String approvedBy;
    private String reviewCycle;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    public CompensationPlan() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getEmployeeId() { return employeeId; }
    public void setEmployeeId(String employeeId) { this.employeeId = employeeId; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public BigDecimal getCurrentBaseSalary() { return currentBaseSalary; }
    public void setCurrentBaseSalary(BigDecimal currentBaseSalary) { this.currentBaseSalary = currentBaseSalary; }
    public BigDecimal getProposedBaseSalary() { return proposedBaseSalary; }
    public void setProposedBaseSalary(BigDecimal proposedBaseSalary) { this.proposedBaseSalary = proposedBaseSalary; }
    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }
    public LocalDate getEffectiveDate() { return effectiveDate; }
    public void setEffectiveDate(LocalDate effectiveDate) { this.effectiveDate = effectiveDate; }
    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getApprovedBy() { return approvedBy; }
    public void setApprovedBy(String approvedBy) { this.approvedBy = approvedBy; }
    public String getReviewCycle() { return reviewCycle; }
    public void setReviewCycle(String reviewCycle) { this.reviewCycle = reviewCycle; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
