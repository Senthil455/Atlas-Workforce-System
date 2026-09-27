package com.ems.payroll.model;

import jakarta.persistence.*;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.PositiveOrZero;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
@Table(name = "salary_benchmarks")
public class SalaryBenchmark {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String tenantId;
    private String role;
    private String experience;
    private String location;
    private String industry;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal percentile10;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal percentile25;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal percentile50;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal percentile75;
    @Min(0) @PositiveOrZero
    @Column(precision = 19, scale = 2)
    private BigDecimal percentile90;
    private String currency;
    private String source;
    private String year;
    private LocalDateTime createdAt;

    public SalaryBenchmark() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }
    public String getExperience() { return experience; }
    public void setExperience(String experience) { this.experience = experience; }
    public String getLocation() { return location; }
    public void setLocation(String location) { this.location = location; }
    public String getIndustry() { return industry; }
    public void setIndustry(String industry) { this.industry = industry; }
    public BigDecimal getPercentile10() { return percentile10; }
    public void setPercentile10(BigDecimal percentile10) { this.percentile10 = percentile10; }
    public BigDecimal getPercentile25() { return percentile25; }
    public void setPercentile25(BigDecimal percentile25) { this.percentile25 = percentile25; }
    public BigDecimal getPercentile50() { return percentile50; }
    public void setPercentile50(BigDecimal percentile50) { this.percentile50 = percentile50; }
    public BigDecimal getPercentile75() { return percentile75; }
    public void setPercentile75(BigDecimal percentile75) { this.percentile75 = percentile75; }
    public BigDecimal getPercentile90() { return percentile90; }
    public void setPercentile90(BigDecimal percentile90) { this.percentile90 = percentile90; }
    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getYear() { return year; }
    public void setYear(String year) { this.year = year; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
