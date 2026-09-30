package com.ems.payroll.model;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
@Table(name = "country_tax_configs")
public class CountryTaxConfig {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String tenantId;
    private String country;
    private String currency;
    private String taxYear;
    @Column(precision = 19, scale = 2)
    private BigDecimal standardDeduction;
    // Rates stay as double; see Money for the money/rate boundary.
    private Double socialSecurityRate;
    private Double medicareRate;
    private Double corporateTaxRate;
    private Boolean hasProgressiveTax;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    public CountryTaxConfig() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public String getCountry() { return country; }
    public void setCountry(String country) { this.country = country; }
    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }
    public String getTaxYear() { return taxYear; }
    public void setTaxYear(String taxYear) { this.taxYear = taxYear; }
    public BigDecimal getStandardDeduction() { return standardDeduction; }
    public void setStandardDeduction(BigDecimal standardDeduction) { this.standardDeduction = standardDeduction; }
    public Double getSocialSecurityRate() { return socialSecurityRate; }
    public void setSocialSecurityRate(Double socialSecurityRate) { this.socialSecurityRate = socialSecurityRate; }
    public Double getMedicareRate() { return medicareRate; }
    public void setMedicareRate(Double medicareRate) { this.medicareRate = medicareRate; }
    public Double getCorporateTaxRate() { return corporateTaxRate; }
    public void setCorporateTaxRate(Double corporateTaxRate) { this.corporateTaxRate = corporateTaxRate; }
    public Boolean getHasProgressiveTax() { return hasProgressiveTax; }
    public void setHasProgressiveTax(Boolean hasProgressiveTax) { this.hasProgressiveTax = hasProgressiveTax; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
