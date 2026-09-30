package com.ems.payroll.model;

import jakarta.persistence.*;
import java.math.BigDecimal;

@Entity
@Table(name = "tax_brackets")
public class TaxBracket {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String tenantId;
    private String country;
    private String taxYear;
    @Column(precision = 19, scale = 2)
    private BigDecimal minIncome;
    @Column(precision = 19, scale = 2)
    private BigDecimal maxIncome;
    // Tax rate as a fraction (for example 0.15 for 15%). Rates are statistical
    // inputs and stay as double; they become money only inside Money.percentOf.
    private Double rate;
    @Column(precision = 19, scale = 2)
    private BigDecimal flatAmount;
    private Integer bracketOrder;

    public TaxBracket() {}

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public String getCountry() { return country; }
    public void setCountry(String country) { this.country = country; }
    public String getTaxYear() { return taxYear; }
    public void setTaxYear(String taxYear) { this.taxYear = taxYear; }
    public BigDecimal getMinIncome() { return minIncome; }
    public void setMinIncome(BigDecimal minIncome) { this.minIncome = minIncome; }
    public BigDecimal getMaxIncome() { return maxIncome; }
    public void setMaxIncome(BigDecimal maxIncome) { this.maxIncome = maxIncome; }
    public Double getRate() { return rate; }
    public void setRate(Double rate) { this.rate = rate; }
    public BigDecimal getFlatAmount() { return flatAmount; }
    public void setFlatAmount(BigDecimal flatAmount) { this.flatAmount = flatAmount; }
    public Integer getBracketOrder() { return bracketOrder; }
    public void setBracketOrder(Integer bracketOrder) { this.bracketOrder = bracketOrder; }
}
