package com.ems.payroll.model;

import jakarta.persistence.*;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.PositiveOrZero;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
@Table(name = "enhanced_payroll_records", indexes = {
    @Index(name = "idx_epr_employee", columnList = "employeeId"),
    @Index(name = "idx_epr_period", columnList = "period")
})
public class EnhancedPayrollRecord {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String employeeId;
    private String tenantId;
    private String period;
    private String country;
    private String currency;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal baseSalary;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal allowances;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal deductions;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal tax;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal socialSecurity;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal medicare;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal netSalary;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal grossSalary;
    private String paymentMethod;
    private String bankAccount;
    private String bankRouting;
    private String status;
    private LocalDateTime processedDate;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    public EnhancedPayrollRecord() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getEmployeeId() { return employeeId; }
    public void setEmployeeId(String employeeId) { this.employeeId = employeeId; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public String getPeriod() { return period; }
    public void setPeriod(String period) { this.period = period; }
    public String getCountry() { return country; }
    public void setCountry(String country) { this.country = country; }
    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }
    public BigDecimal getBaseSalary() { return baseSalary; }
    public void setBaseSalary(BigDecimal baseSalary) { this.baseSalary = baseSalary; }
    public BigDecimal getAllowances() { return allowances; }
    public void setAllowances(BigDecimal allowances) { this.allowances = allowances; }
    public BigDecimal getDeductions() { return deductions; }
    public void setDeductions(BigDecimal deductions) { this.deductions = deductions; }
    public BigDecimal getTax() { return tax; }
    public void setTax(BigDecimal tax) { this.tax = tax; }
    public BigDecimal getSocialSecurity() { return socialSecurity; }
    public void setSocialSecurity(BigDecimal socialSecurity) { this.socialSecurity = socialSecurity; }
    public BigDecimal getMedicare() { return medicare; }
    public void setMedicare(BigDecimal medicare) { this.medicare = medicare; }
    public BigDecimal getNetSalary() { return netSalary; }
    public void setNetSalary(BigDecimal netSalary) { this.netSalary = netSalary; }
    public BigDecimal getGrossSalary() { return grossSalary; }
    public void setGrossSalary(BigDecimal grossSalary) { this.grossSalary = grossSalary; }
    public String getPaymentMethod() { return paymentMethod; }
    public void setPaymentMethod(String paymentMethod) { this.paymentMethod = paymentMethod; }
    public String getBankAccount() { return bankAccount; }
    public void setBankAccount(String bankAccount) { this.bankAccount = bankAccount; }
    public String getBankRouting() { return bankRouting; }
    public void setBankRouting(String bankRouting) { this.bankRouting = bankRouting; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public LocalDateTime getProcessedDate() { return processedDate; }
    public void setProcessedDate(LocalDateTime processedDate) { this.processedDate = processedDate; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
