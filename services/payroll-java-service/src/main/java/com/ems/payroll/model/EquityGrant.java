package com.ems.payroll.model;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Entity
@Table(name = "equity_grants")
public class EquityGrant {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String employeeId;
    private String tenantId;
    @Column(precision = 19, scale = 4)
    private BigDecimal shares;
    @Column(precision = 19, scale = 2)
    private BigDecimal strikePrice;
    @Column(precision = 19, scale = 2)
    private BigDecimal fairMarketValue;
    private LocalDate grantDate;
    private LocalDate vestingStart;
    private LocalDate vestingEnd;
    private String vestingSchedule;
    private String equityType;
    private String status;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    public EquityGrant() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getEmployeeId() { return employeeId; }
    public void setEmployeeId(String employeeId) { this.employeeId = employeeId; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public BigDecimal getShares() { return shares; }
    public void setShares(BigDecimal shares) { this.shares = shares; }
    public BigDecimal getStrikePrice() { return strikePrice; }
    public void setStrikePrice(BigDecimal strikePrice) { this.strikePrice = strikePrice; }
    public BigDecimal getFairMarketValue() { return fairMarketValue; }
    public void setFairMarketValue(BigDecimal fairMarketValue) { this.fairMarketValue = fairMarketValue; }
    public LocalDate getGrantDate() { return grantDate; }
    public void setGrantDate(LocalDate grantDate) { this.grantDate = grantDate; }
    public LocalDate getVestingStart() { return vestingStart; }
    public void setVestingStart(LocalDate vestingStart) { this.vestingStart = vestingStart; }
    public LocalDate getVestingEnd() { return vestingEnd; }
    public void setVestingEnd(LocalDate vestingEnd) { this.vestingEnd = vestingEnd; }
    public String getVestingSchedule() { return vestingSchedule; }
    public void setVestingSchedule(String vestingSchedule) { this.vestingSchedule = vestingSchedule; }
    public String getEquityType() { return equityType; }
    public void setEquityType(String equityType) { this.equityType = equityType; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
