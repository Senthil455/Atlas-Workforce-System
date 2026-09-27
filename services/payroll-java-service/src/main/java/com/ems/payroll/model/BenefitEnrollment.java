package com.ems.payroll.model;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Entity
@Table(name = "benefit_enrollments")
public class BenefitEnrollment {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String employeeId;
    private String tenantId;
    private Long planId;
    private LocalDate enrollmentDate;
    private LocalDate effectiveDate;
    private LocalDate terminationDate;
    private String status;
    @Column(precision = 19, scale = 2)
    private BigDecimal employeeContribution;
    @Column(precision = 19, scale = 2)
    private BigDecimal employerContribution;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    public BenefitEnrollment() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getEmployeeId() { return employeeId; }
    public void setEmployeeId(String employeeId) { this.employeeId = employeeId; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public Long getPlanId() { return planId; }
    public void setPlanId(Long planId) { this.planId = planId; }
    public LocalDate getEnrollmentDate() { return enrollmentDate; }
    public void setEnrollmentDate(LocalDate enrollmentDate) { this.enrollmentDate = enrollmentDate; }
    public LocalDate getEffectiveDate() { return effectiveDate; }
    public void setEffectiveDate(LocalDate effectiveDate) { this.effectiveDate = effectiveDate; }
    public LocalDate getTerminationDate() { return terminationDate; }
    public void setTerminationDate(LocalDate terminationDate) { this.terminationDate = terminationDate; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public BigDecimal getEmployeeContribution() { return employeeContribution; }
    public void setEmployeeContribution(BigDecimal employeeContribution) { this.employeeContribution = employeeContribution; }
    public BigDecimal getEmployerContribution() { return employerContribution; }
    public void setEmployerContribution(BigDecimal employerContribution) { this.employerContribution = employerContribution; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
