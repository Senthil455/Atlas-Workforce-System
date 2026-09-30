package com.ems.payroll.service;

import com.ems.payroll.model.*;
import com.ems.payroll.repository.*;
import com.ems.payroll.util.Money;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class PayrollEnterpriseService {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final EnhancedPayrollRepository payrollRepo;
    private final CountryTaxConfigRepository taxConfigRepo;
    private final TaxBracketRepository taxBracketRepo;
    private final PayrollAuditRepository auditRepo;
    private final ExpenseReportRepository expenseRepo;
    private final BenefitPlanRepository benefitPlanRepo;
    private final BenefitEnrollmentRepository benefitEnrollRepo;
    private final BonusRepository bonusRepo;
    private final EquityGrantRepository equityRepo;
    private final CompensationPlanRepository compensationRepo;
    private final SalaryBenchmarkRepository benchmarkRepo;
    private final PayrollForecastRepository forecastRepo;
    private final BankTransactionRepository bankRepo;
    private final PayrollComplianceReportRepository complianceRepo;
    private final PayrollAnomalyRepository anomalyRepo;
    private final PayslipRepository payslipRepo;
    private final OutboxEventRepository outboxEventRepository;

    public PayrollEnterpriseService(
            EnhancedPayrollRepository payrollRepo,
            CountryTaxConfigRepository taxConfigRepo,
            TaxBracketRepository taxBracketRepo,
            PayrollAuditRepository auditRepo,
            ExpenseReportRepository expenseRepo,
            BenefitPlanRepository benefitPlanRepo,
            BenefitEnrollmentRepository benefitEnrollRepo,
            BonusRepository bonusRepo,
            EquityGrantRepository equityRepo,
            CompensationPlanRepository compensationRepo,
            SalaryBenchmarkRepository benchmarkRepo,
            PayrollForecastRepository forecastRepo,
            BankTransactionRepository bankRepo,
            PayrollComplianceReportRepository complianceRepo,
            PayrollAnomalyRepository anomalyRepo,
            PayslipRepository payslipRepo,
            OutboxEventRepository outboxEventRepository) {
        this.payrollRepo = payrollRepo;
        this.taxConfigRepo = taxConfigRepo;
        this.taxBracketRepo = taxBracketRepo;
        this.auditRepo = auditRepo;
        this.expenseRepo = expenseRepo;
        this.benefitPlanRepo = benefitPlanRepo;
        this.benefitEnrollRepo = benefitEnrollRepo;
        this.bonusRepo = bonusRepo;
        this.equityRepo = equityRepo;
        this.compensationRepo = compensationRepo;
        this.benchmarkRepo = benchmarkRepo;
        this.forecastRepo = forecastRepo;
        this.bankRepo = bankRepo;
        this.complianceRepo = complianceRepo;
        this.anomalyRepo = anomalyRepo;
        this.payslipRepo = payslipRepo;
        this.outboxEventRepository = outboxEventRepository;
    }

    // ============================================================
    // 1. MULTI-COUNTRY PAYROLL + TAX ENGINE
    // ============================================================

    @Transactional
    public EnhancedPayrollRecord runMultiCountryPayroll(String tenantId, String employeeId, String period,
                                                         BigDecimal baseSalary, BigDecimal allowances, BigDecimal deductions,
                                                         String country, String currency) {
        try {
            List<EnhancedPayrollRecord> existing = payrollRepo.findByTenantIdAndEmployeeIdAndPeriod(tenantId, employeeId, period);
            if (!existing.isEmpty()) {
                throw new IllegalArgumentException("Payroll already processed for this period");
            }

            BigDecimal grossSalary = Money.subtract(Money.add(baseSalary, allowances), deductions);
            CountryTaxConfig taxConfig = taxConfigRepo.findByTenantIdAndCountry(tenantId, country)
                    .orElse(null);

            BigDecimal tax = Money.zero();
            BigDecimal socialSecurity = Money.zero();
            BigDecimal medicare = Money.zero();

            if (taxConfig != null) {
                tax = calculateProgressiveTax(tenantId, country, taxConfig.getTaxYear(), grossSalary);
                if (taxConfig.getSocialSecurityRate() != null) {
                    socialSecurity = Money.percentOf(grossSalary, taxConfig.getSocialSecurityRate());
                }
                if (taxConfig.getMedicareRate() != null) {
                    medicare = Money.percentOf(grossSalary, taxConfig.getMedicareRate());
                }
            } else {
                tax = calculateSimpleTax(grossSalary);
            }

            BigDecimal netSalary = Money.subtract(Money.subtract(grossSalary, tax), Money.add(socialSecurity, medicare));

            EnhancedPayrollRecord record = new EnhancedPayrollRecord();
            record.setTenantId(tenantId);
            record.setEmployeeId(employeeId);
            record.setPeriod(period);
            record.setCountry(country);
            record.setCurrency(currency != null ? currency : "USD");
            record.setBaseSalary(baseSalary);
            record.setAllowances(allowances);
            record.setDeductions(deductions);
            record.setGrossSalary(grossSalary);
            record.setTax(tax);
            record.setSocialSecurity(socialSecurity);
            record.setMedicare(medicare);
            record.setNetSalary(netSalary);
            record.setStatus("PROCESSED");
            record.setProcessedDate(LocalDateTime.now());
            record.setCreatedAt(LocalDateTime.now());
            record.setUpdatedAt(LocalDateTime.now());

            record = payrollRepo.save(record);

            // Generate payslip
            generatePayslip(record);

            // Audit
            auditAction(tenantId, record.getId(), "RUN_PAYROLL", "system", "none", record.getStatus());

            // Detect anomalies
            detectPayrollAnomalies(record);

            // Outbox event
            OutboxEvent outboxEvent = new OutboxEvent();
            outboxEvent.setAggregateType("payroll");
            outboxEvent.setAggregateId(String.valueOf(record.getId()));
            outboxEvent.setEventType("PAYROLL_PROCESSED");
            outboxEvent.setPayload(toJson(Map.of(
                "payrollId", record.getId(),
                "employeeId", employeeId,
                "period", period,
                "grossAmount", grossSalary,
                "netAmount", netSalary,
                "currency", currency != null ? currency : "USD",
                "status", "PROCESSED",
                "timestamp", LocalDateTime.now().toString(),
                "tenantId", tenantId
            )));
            outboxEvent.setStatus("PENDING");
            outboxEvent.setRetryCount(0);
            outboxEvent.setCreatedAt(LocalDateTime.now());
            outboxEventRepository.save(outboxEvent);

            return record;
        } catch (Exception e) {
            OutboxEvent outboxEvent = new OutboxEvent();
            outboxEvent.setAggregateType("payroll");
            outboxEvent.setAggregateId("0");
            outboxEvent.setEventType("PAYROLL_FAILED");
            outboxEvent.setPayload(toJson(Map.of(
                "employeeId", employeeId,
                "period", period,
                "error", e.getMessage(),
                "timestamp", LocalDateTime.now().toString(),
                "tenantId", tenantId
            )));
            outboxEvent.setStatus("PENDING");
            outboxEvent.setRetryCount(0);
            outboxEvent.setCreatedAt(LocalDateTime.now());
            outboxEventRepository.save(outboxEvent);
            throw e;
        }
    }

    public BigDecimal calculateProgressiveTax(String tenantId, String country, String taxYear, BigDecimal grossSalary) {
        BigDecimal gross = Money.of(grossSalary);
        List<TaxBracket> brackets = taxBracketRepo.findByTenantIdAndCountryAndTaxYearOrderByBracketOrder(tenantId, country, taxYear);
        if (brackets.isEmpty()) {
            return calculateSimpleTax(gross);
        }
        // Ensure brackets are processed in order
        brackets.sort(Comparator.comparingInt(b -> b.getBracketOrder() != null ? b.getBracketOrder() : 0));

        BigDecimal tax = Money.zero();
        for (TaxBracket bracket : brackets) {
            BigDecimal minIncome = Money.of(bracket.getMinIncome());
            BigDecimal maxIncome = bracket.getMaxIncome() != null
                    && bracket.getMaxIncome().compareTo(BigDecimal.ZERO) > 0
                    ? Money.of(bracket.getMaxIncome()) : null;
            double rate = bracket.getRate() != null ? bracket.getRate() : 0;
            BigDecimal flatAmount = Money.of(bracket.getFlatAmount());

            if (gross.compareTo(minIncome) <= 0) {
                break;
            }

            BigDecimal upper = (maxIncome != null && gross.compareTo(maxIncome) < 0) ? gross : (maxIncome != null ? maxIncome : gross);
            // When maxIncome is null the bracket is open-ended, so the upper bound is gross itself.
            if (maxIncome == null) {
                upper = gross;
            }
            BigDecimal taxableInBracket = Money.of(upper.subtract(minIncome));
            if (taxableInBracket.compareTo(BigDecimal.ZERO) <= 0) {
                continue;
            }

            // Flat amount handling: a flatAmount is the tax for income up to
            // minIncome (base tax). The old loop always did `tax += flatAmount`
            // which double counts and makes 10100 and 19900 pay the same flat
            // regardless of marginal amount. Correct progressive tax is the sum
            // of `taxableInBracket * rate` across brackets. When a bracket has
            // a non-zero rate we ignore flatAmount and use the marginal rate
            // (the base is already covered by the sum of lower brackets). Only
            // for flat-only brackets (fixed fee with no rate) do we apply the
            // flat amount.
            if (flatAmount.compareTo(BigDecimal.ZERO) > 0 && rate == 0) {
                tax = Money.add(tax, flatAmount);
            } else {
                tax = Money.add(tax, Money.percentOf(taxableInBracket, rate));
            }

            if (maxIncome != null && gross.compareTo(maxIncome) <= 0) {
                break;
            }
        }
        return tax;
    }

    public BigDecimal calculateSimpleTax(BigDecimal grossSalary) {
        BigDecimal gross = Money.of(grossSalary);
        BigDecimal threeK = new BigDecimal("3000.00");
        BigDecimal sevenK = new BigDecimal("7000.00");
        BigDecimal twelveK = new BigDecimal("12000.00");
        if (gross.compareTo(threeK) <= 0) return Money.zero();
        if (gross.compareTo(sevenK) <= 0) return Money.percentOf(gross.subtract(threeK), 0.15);
        if (gross.compareTo(twelveK) <= 0) {
            return Money.add(
                    Money.percentOf(new BigDecimal("4000.00"), 0.15),
                    Money.percentOf(gross.subtract(sevenK), 0.25));
        }
        return Money.add(
                Money.add(
                        Money.percentOf(new BigDecimal("4000.00"), 0.15),
                        Money.percentOf(new BigDecimal("5000.00"), 0.25)),
                Money.percentOf(gross.subtract(twelveK), 0.35));
    }

    // ============================================================
    // 2. TAX SIMULATIONS
    // ============================================================

    public Map<String, Object> simulateTax(String tenantId, String country, BigDecimal grossSalary) {
        BigDecimal gross = Money.of(grossSalary);
        CountryTaxConfig taxConfig = taxConfigRepo.findByTenantIdAndCountry(tenantId, country).orElse(null);
        String taxYear = taxConfig != null ? taxConfig.getTaxYear() : String.valueOf(LocalDate.now().getYear());

        BigDecimal tax = calculateProgressiveTax(tenantId, country, taxYear, gross);
        // Effective rate is a statistical percentage, not money, so it stays a double.
        double effectiveRate = gross.compareTo(BigDecimal.ZERO) > 0
                ? tax.divide(gross, 6, java.math.RoundingMode.HALF_UP).doubleValue() * 100 : 0;

        BigDecimal socialSecurity = taxConfig != null && taxConfig.getSocialSecurityRate() != null
                ? Money.percentOf(gross, taxConfig.getSocialSecurityRate()) : Money.zero();
        BigDecimal medicare = taxConfig != null && taxConfig.getMedicareRate() != null
                ? Money.percentOf(gross, taxConfig.getMedicareRate()) : Money.zero();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("grossSalary", gross);
        result.put("country", country);
        result.put("taxYear", taxYear);
        result.put("tax", tax);
        result.put("effectiveTaxRate", Math.round(effectiveRate * 100.0) / 100.0);
        result.put("socialSecurity", socialSecurity);
        result.put("medicare", medicare);
        result.put("totalDeductions", Money.add(Money.add(tax, socialSecurity), medicare));
        result.put("netSalary", Money.subtract(gross, Money.add(Money.add(tax, socialSecurity), medicare)));

        // Bracket breakdown
        List<TaxBracket> brackets = taxBracketRepo.findByTenantIdAndCountryAndTaxYearOrderByBracketOrder(tenantId, country, taxYear);
        List<Map<String, Object>> bracketDetails = new ArrayList<>();
        for (TaxBracket b : brackets) {
            bracketDetails.add(Map.of(
                    "range", b.getMinIncome() + " - " + (b.getMaxIncome() != null ? b.getMaxIncome() : "above"),
                    "rate", (b.getRate() != null ? b.getRate() * 100 : 0) + "%",
                    "flatAmount", b.getFlatAmount() != null ? b.getFlatAmount() : Money.zero()
            ));
        }
        result.put("brackets", bracketDetails);
        return result;
    }

    public List<Map<String, Object>> compareCountryTax(String tenantId, List<String> countries, BigDecimal grossSalary) {
        BigDecimal gross = Money.of(grossSalary);
        List<Map<String, Object>> results = new ArrayList<>();
        for (String country : countries) {
            Map<String, Object> sim = simulateTax(tenantId, country, gross);
            results.add(sim);
        }
        return results;
    }

    // ============================================================
    // 3. PAYROLL FORECASTING
    // ============================================================

    public PayrollForecast generateForecast(String tenantId, String period) {
        BigDecimal totalGross = payrollRepo.sumGrossSalaryByTenant(tenantId);
        if (totalGross == null) totalGross = Money.zero();
        totalGross = Money.of(totalGross);

        // Simple forecast: project based on historical trends
        BigDecimal projectedGross = Money.percentOf(totalGross, 1.03);
        BigDecimal projectedTax = Money.percentOf(projectedGross, 0.25);
        BigDecimal projectedNet = Money.subtract(projectedGross, projectedTax);
        BigDecimal projectedBenefits = Money.percentOf(projectedGross, 0.08);

        PayrollForecast forecast = new PayrollForecast();
        forecast.setTenantId(tenantId);
        forecast.setPeriod(period);
        forecast.setProjectedGrossPayroll(projectedGross);
        forecast.setProjectedNetPayroll(projectedNet);
        forecast.setProjectedTax(projectedTax);
        forecast.setProjectedBenefits(projectedBenefits);
        forecast.setConfidence(85.0);
        forecast.setFactors("Based on historical payroll data with 3% growth adjustment");
        forecast.setStatus("ACTIVE");
        forecast.setGeneratedAt(LocalDateTime.now());
        forecast.setCreatedAt(LocalDateTime.now());

        return forecastRepo.save(forecast);
    }

    // ============================================================
    // 4. PAYROLL AUDITING
    // ============================================================

    public PayrollAudit auditAction(String tenantId, Long payrollId, String action, String changedBy,
                                    String oldValue, String newValue) {
        PayrollAudit audit = new PayrollAudit();
        audit.setTenantId(tenantId);
        audit.setPayrollId(payrollId);
        audit.setAction(action);
        audit.setChangedBy(changedBy);
        audit.setOldValue(oldValue);
        audit.setNewValue(newValue);
        audit.setChangedAt(LocalDateTime.now());
        return auditRepo.save(audit);
    }

    public List<PayrollAudit> getAuditLogs(String tenantId) {
        return auditRepo.findByTenantId(tenantId);
    }

    // ============================================================
    // 5. PAYSLIP PDF GENERATION
    // ============================================================

    public Payslip generatePayslip(EnhancedPayrollRecord record) {
        if (record == null || record.getId() == null) return null;

        Optional<Payslip> existing = payslipRepo.findByPayrollId(record.getId());
        if (existing.isPresent()) return existing.get();

        StringBuilder pdf = new StringBuilder();
        pdf.append("=== PAYSLIP ===\n");
        pdf.append("Employee: ").append(record.getEmployeeId()).append("\n");
        pdf.append("Period: ").append(record.getPeriod()).append("\n");
        pdf.append("Country: ").append(record.getCountry()).append("\n");
        pdf.append("Currency: ").append(record.getCurrency()).append("\n");
        pdf.append("---\n");
        pdf.append("Base Salary: ").append(String.format("%.2f", record.getBaseSalary())).append("\n");
        pdf.append("Allowances: ").append(String.format("%.2f", record.getAllowances())).append("\n");
        pdf.append("Deductions: ").append(String.format("%.2f", record.getDeductions())).append("\n");
        pdf.append("Gross Salary: ").append(String.format("%.2f", record.getGrossSalary())).append("\n");
        pdf.append("Tax: ").append(String.format("%.2f", record.getTax())).append("\n");
        pdf.append("Social Security: ").append(String.format("%.2f", record.getSocialSecurity())).append("\n");
        pdf.append("Medicare: ").append(String.format("%.2f", record.getMedicare())).append("\n");
        pdf.append("Net Salary: ").append(String.format("%.2f", record.getNetSalary())).append("\n");
        pdf.append("---\n");
        pdf.append("Status: ").append(record.getStatus()).append("\n");
        pdf.append("Processed: ").append(record.getProcessedDate()).append("\n");

        Payslip payslip = new Payslip();
        payslip.setPayrollId(record.getId());
        payslip.setEmployeeId(record.getEmployeeId());
        payslip.setTenantId(record.getTenantId());
        payslip.setPeriod(record.getPeriod());
        payslip.setPdfContent(pdf.toString());
        payslip.setGeneratedAt(LocalDateTime.now());
        payslip.setCreatedAt(LocalDateTime.now());
        return payslipRepo.save(payslip);
    }

    // ============================================================
    // 6. DIRECT BANK INTEGRATION
    // ============================================================

    @Transactional
    public BankTransaction createBankTransaction(String tenantId, Long payrollId, String employeeId,
                                                  BigDecimal amount, String accountNumber, String routingNumber,
                                                  String bankName) {
        BankTransaction tx = new BankTransaction();
        tx.setTenantId(tenantId);
        tx.setPayrollId(payrollId);
        tx.setEmployeeId(employeeId);
        tx.setAmount(Money.of(amount));
        tx.setAccountNumber(accountNumber);
        tx.setRoutingNumber(routingNumber);
        tx.setBankName(bankName);
        tx.setTransactionType("PAYROLL_DIRECT_DEPOSIT");
        tx.setReference("PAY-" + payrollId + "-" + System.currentTimeMillis());
        tx.setStatus("PENDING");
        tx.setCreatedAt(LocalDateTime.now());
        return bankRepo.save(tx);
    }

    public BankTransaction processBankTransaction(Long txId) {
        BankTransaction tx = bankRepo.findById(txId).orElseThrow(
                () -> new IllegalArgumentException("Bank transaction not found"));
        tx.setStatus("PROCESSED");
        tx.setProcessedAt(LocalDateTime.now());
        return bankRepo.save(tx);
    }

    // ============================================================
    // 7. EXPENSE REIMBURSEMENTS
    // ============================================================

    @Transactional
    public ExpenseReport submitExpense(String tenantId, String employeeId, String category, BigDecimal amount,
                                        String description, String receiptUrl) {
        ExpenseReport expense = new ExpenseReport();
        expense.setTenantId(tenantId);
        expense.setEmployeeId(employeeId);
        expense.setCategory(category);
        expense.setAmount(Money.of(amount));
        expense.setDescription(description);
        expense.setReceiptUrl(receiptUrl);
        expense.setExpenseDate(LocalDate.now());
        expense.setStatus("PENDING");
        expense.setSubmittedAt(LocalDateTime.now());
        expense.setCreatedAt(LocalDateTime.now());
        return expenseRepo.save(expense);
    }

    @Transactional
    public ExpenseReport approveExpense(Long expenseId, String approvedBy) {
        ExpenseReport expense = expenseRepo.findById(expenseId).orElseThrow(
                () -> new IllegalArgumentException("Expense not found"));
        validateEmployeeExists(expense.getTenantId(), expense.getEmployeeId());
        expense.setStatus("APPROVED");
        expense.setApprovedBy(approvedBy);
        expense.setProcessedAt(LocalDateTime.now());
        return expenseRepo.save(expense);
    }

    @Transactional
    public ExpenseReport rejectExpense(Long expenseId, String reason) {
        ExpenseReport expense = expenseRepo.findById(expenseId).orElseThrow(
                () -> new IllegalArgumentException("Expense not found"));
        expense.setStatus("REJECTED");
        expense.setRejectedReason(reason);
        expense.setProcessedAt(LocalDateTime.now());
        return expenseRepo.save(expense);
    }

    // ============================================================
    // 8. BENEFITS ADMINISTRATION
    // ============================================================

    public BenefitPlan createBenefitPlan(String tenantId, String name, String type, String description,
                                          BigDecimal employerContribution, BigDecimal employeeContribution, BigDecimal maxAmount) {
        BenefitPlan plan = new BenefitPlan();
        plan.setTenantId(tenantId);
        plan.setName(name);
        plan.setType(type);
        plan.setDescription(description);
        plan.setEmployerContribution(Money.of(employerContribution));
        plan.setEmployeeContribution(Money.of(employeeContribution));
        plan.setMaxBenefitAmount(Money.of(maxAmount));
        plan.setIsActive(true);
        plan.setCreatedAt(LocalDateTime.now());
        plan.setUpdatedAt(LocalDateTime.now());
        return benefitPlanRepo.save(plan);
    }

    @Transactional
    public BenefitEnrollment enrollInBenefit(String tenantId, String employeeId, Long planId) {
        BenefitPlan plan = benefitPlanRepo.findById(planId).orElseThrow(
                () -> new IllegalArgumentException("Benefit plan not found"));

        if (plan.getMaxParticipants() != null && plan.getCurrentParticipants() != null
                && plan.getCurrentParticipants() >= plan.getMaxParticipants()) {
            throw new IllegalStateException("Benefit plan has reached maximum capacity");
        }

        List<BenefitEnrollment> existing = benefitEnrollRepo.findByTenantIdAndEmployeeId(tenantId, employeeId);
        boolean alreadyEnrolled = existing.stream().anyMatch(e -> e.getPlanId().equals(planId) && "ACTIVE".equals(e.getStatus()));
        if (alreadyEnrolled) {
            throw new IllegalArgumentException("Employee is already enrolled in this benefit plan");
        }

        BenefitEnrollment enrollment = new BenefitEnrollment();
        enrollment.setTenantId(tenantId);
        enrollment.setEmployeeId(employeeId);
        enrollment.setPlanId(planId);
        enrollment.setEnrollmentDate(LocalDate.now());
        enrollment.setEffectiveDate(LocalDate.now());
        enrollment.setStatus("ACTIVE");
        enrollment.setEmployeeContribution(plan.getEmployeeContribution());
        enrollment.setEmployerContribution(plan.getEmployerContribution());
        enrollment.setCreatedAt(LocalDateTime.now());
        enrollment.setUpdatedAt(LocalDateTime.now());

        enrollment = benefitEnrollRepo.save(enrollment);

        plan.setCurrentParticipants(plan.getCurrentParticipants() != null ? plan.getCurrentParticipants() + 1 : 1);
        benefitPlanRepo.save(plan);

        return enrollment;
    }

    // ============================================================
    // 9. COMPENSATION PLANNING
    // ============================================================

    @Transactional
    public CompensationPlan createCompensationPlan(String tenantId, String employeeId, BigDecimal currentSalary,
                                                    BigDecimal proposedSalary, String currency, String reason, String reviewCycle) {
        CompensationPlan plan = new CompensationPlan();
        plan.setTenantId(tenantId);
        plan.setEmployeeId(employeeId);
        plan.setCurrentBaseSalary(Money.of(currentSalary));
        plan.setProposedBaseSalary(Money.of(proposedSalary));
        plan.setCurrency(currency);
        plan.setReason(reason);
        plan.setReviewCycle(reviewCycle);
        plan.setEffectiveDate(LocalDate.now().plusMonths(1));
        plan.setStatus("PENDING");
        plan.setCreatedAt(LocalDateTime.now());
        plan.setUpdatedAt(LocalDateTime.now());

        plan = compensationRepo.save(plan);
        auditAction(tenantId, plan.getId(), "COMPENSATION_PLAN", "system",
                String.valueOf(currentSalary), String.valueOf(proposedSalary));
        return plan;
    }

    // ============================================================
    // 10. BONUS MANAGEMENT
    // ============================================================

    @Transactional
    public Bonus createBonus(String tenantId, String employeeId, BigDecimal amount, String type, String reason) {
        Bonus bonus = new Bonus();
        bonus.setTenantId(tenantId);
        bonus.setEmployeeId(employeeId);
        bonus.setAmount(Money.of(amount));
        bonus.setType(type);
        bonus.setReason(reason);
        bonus.setAwardDate(LocalDate.now());
        bonus.setStatus("PENDING");
        bonus.setCreatedAt(LocalDateTime.now());
        bonus.setUpdatedAt(LocalDateTime.now());
        return bonusRepo.save(bonus);
    }

    @Transactional
    public Bonus approveBonus(Long bonusId, String approvedBy) {
        Bonus bonus = bonusRepo.findById(bonusId).orElseThrow(
                () -> new IllegalArgumentException("Bonus not found"));
        bonus.setStatus("APPROVED");
        bonus.setApprovedBy(approvedBy);
        bonus.setUpdatedAt(LocalDateTime.now());
        return bonusRepo.save(bonus);
    }

    // ============================================================
    // 11. EQUITY MANAGEMENT
    // ============================================================

    @Transactional
    public EquityGrant createEquityGrant(String tenantId, String employeeId, BigDecimal shares, BigDecimal strikePrice,
                                          BigDecimal fairMarketValue, String equityType, String vestingSchedule) {
        EquityGrant grant = new EquityGrant();
        grant.setTenantId(tenantId);
        grant.setEmployeeId(employeeId);
        grant.setShares(shares == null ? null : new BigDecimal(shares.toString()));
        grant.setStrikePrice(Money.of(strikePrice));
        grant.setFairMarketValue(Money.of(fairMarketValue));
        grant.setEquityType(equityType);
        grant.setVestingSchedule(vestingSchedule);
        grant.setGrantDate(LocalDate.now());
        grant.setVestingStart(LocalDate.now());
        grant.setVestingEnd(LocalDate.now().plusYears(4));
        grant.setStatus("GRANTED");
        grant.setCreatedAt(LocalDateTime.now());
        grant.setUpdatedAt(LocalDateTime.now());
        return equityRepo.save(grant);
    }

    // ============================================================
    // 12. SALARY BENCHMARKING
    // ============================================================

    public SalaryBenchmark addBenchmark(String tenantId, String role, String experience, String location,
                                         BigDecimal p10, BigDecimal p25, BigDecimal p50, BigDecimal p75, BigDecimal p90,
                                         String currency, String source) {
        SalaryBenchmark benchmark = new SalaryBenchmark();
        benchmark.setTenantId(tenantId);
        benchmark.setRole(role);
        benchmark.setExperience(experience);
        benchmark.setLocation(location);
        benchmark.setPercentile10(Money.of(p10));
        benchmark.setPercentile25(Money.of(p25));
        benchmark.setPercentile50(Money.of(p50));
        benchmark.setPercentile75(Money.of(p75));
        benchmark.setPercentile90(Money.of(p90));
        benchmark.setCurrency(currency);
        benchmark.setSource(source);
        benchmark.setYear(String.valueOf(LocalDate.now().getYear()));
        benchmark.setCreatedAt(LocalDateTime.now());
        return benchmarkRepo.save(benchmark);
    }

    public Map<String, Object> compareToBenchmark(String tenantId, String role, String experience,
                                                   String location, BigDecimal currentSalary) {
        Optional<SalaryBenchmark> opt = benchmarkRepo.findByTenantIdAndRoleAndExperienceAndLocation(
                tenantId, role, experience, location);
        if (opt.isEmpty()) {
            return Map.of("error", "No benchmark data found for this role/experience/location");
        }
        SalaryBenchmark b = opt.get();
        BigDecimal current = Money.of(currentSalary);
        String position;
        if (current.compareTo(b.getPercentile25()) < 0) position = "Below 25th percentile";
        else if (current.compareTo(b.getPercentile50()) < 0) position = "Between 25th-50th percentile";
        else if (current.compareTo(b.getPercentile75()) < 0) position = "Between 50th-75th percentile";
        else position = "Above 75th percentile";

        // vsMedian is a statistical percentage, not money.
        double vsMedian = b.getPercentile50() != null && b.getPercentile50().compareTo(BigDecimal.ZERO) > 0
                ? current.subtract(b.getPercentile50()).divide(b.getPercentile50(), 6, java.math.RoundingMode.HALF_UP).doubleValue() * 100 : 0;

        return Map.of(
                "role", role, "experience", experience, "location", location,
                "currentSalary", currentSalary,
                "p25", b.getPercentile25(), "p50", b.getPercentile50(), "p75", b.getPercentile75(),
                "position", position,
                "vsMedianPercent", Math.round(vsMedian * 100.0) / 100.0,
                "currency", b.getCurrency()
        );
    }

    // ============================================================
    // 13. PAYROLL COMPLIANCE REPORTS
    // ============================================================

    public PayrollComplianceReport generateComplianceReport(String tenantId, String reportType, String period, String country) {
        String summary = reportType + " compliance report for " + period;
        StringBuilder details = new StringBuilder();

        if ("TAX".equals(reportType)) {
            BigDecimal totalTax = Money.of(payrollRepo.sumTaxByTenantAndPeriod(tenantId, period));
            BigDecimal totalGross = Money.of(payrollRepo.sumBaseSalaryByTenantAndPeriod(tenantId, period));
            details.append("Total Tax Withheld: ").append(totalTax).append("\n");
            details.append("Total Gross Payroll: ").append(totalGross).append("\n");
            if (totalGross.compareTo(BigDecimal.ZERO) > 0) {
                BigDecimal rate = totalTax.divide(totalGross, 4, java.math.RoundingMode.HALF_UP)
                        .multiply(new BigDecimal("100")).setScale(2, java.math.RoundingMode.HALF_UP);
                details.append("Effective Tax Rate: ").append(rate).append("%");
            } else {
                details.append("Effective Tax Rate: 0%");
            }
        } else if ("SOCIAL_SECURITY".equals(reportType)) {
            BigDecimal totalGross = Money.of(payrollRepo.sumBaseSalaryByTenantAndPeriod(tenantId, period));
            details.append("Total Gross Payroll: ").append(totalGross).append("\n");
            details.append("Social Security Due: ").append(Money.percentOf(totalGross, 0.062)).append("\n");
            details.append("Medicare Due: ").append(Money.percentOf(totalGross, 0.0145));
        } else {
            List<EnhancedPayrollRecord> records = payrollRepo.findByTenantIdAndPeriod(tenantId, period);
            BigDecimal sum = records.stream()
                    .map(EnhancedPayrollRecord::getNetSalary)
                    .map(Money::of)
                    .reduce(Money.zero(), BigDecimal::add);
            details.append("Total Records: ").append(records.size()).append("\n");
            details.append("Total Net Payroll: ").append(sum);
        }

        PayrollComplianceReport report = new PayrollComplianceReport();
        report.setTenantId(tenantId);
        report.setReportType(reportType);
        report.setPeriod(period);
        report.setCountry(country);
        report.setSummary(summary);
        report.setDetails(details.toString());
        report.setStatus("GENERATED");
        report.setGeneratedAt(LocalDateTime.now());
        report.setCreatedAt(LocalDateTime.now());

        auditAction(tenantId, 0L, "COMPLIANCE_REPORT_" + reportType, "system", "none", period);
        return complianceRepo.save(report);
    }

    // ============================================================
    // 14. PAYROLL ANOMALY DETECTION
    // ============================================================

    public void detectPayrollAnomalies(EnhancedPayrollRecord record) {
        String tenantId = record.getTenantId();

        // Check for salary increase > 50%. Change is a statistical percentage.
        if (record.getGrossSalary() != null && record.getGrossSalary().compareTo(BigDecimal.ZERO) > 0) {
            List<EnhancedPayrollRecord> previous = payrollRepo.findByTenantIdAndEmployeeId(tenantId, record.getEmployeeId());
            if (previous.size() > 1) {
                EnhancedPayrollRecord last = previous.get(previous.size() - 2);
                if (last.getGrossSalary() != null && last.getGrossSalary().compareTo(BigDecimal.ZERO) > 0) {
                    BigDecimal change = record.getGrossSalary().subtract(last.getGrossSalary())
                            .divide(last.getGrossSalary(), 6, java.math.RoundingMode.HALF_UP)
                            .multiply(new BigDecimal("100")).abs();
                    if (change.compareTo(new BigDecimal("50")) > 0) {
                        saveAnomaly(tenantId, record.getId(), record.getEmployeeId(),
                                "salary_spike", "high",
                                "Salary changed by " + change.setScale(1, java.math.RoundingMode.HALF_UP) + "% compared to previous period");
                    }
                }
            }
        }

        // Check for duplicate period
        List<EnhancedPayrollRecord> duplicates = payrollRepo.findByTenantIdAndPeriod(tenantId, record.getPeriod());
        long sameEmployee = duplicates.stream().filter(r -> r.getEmployeeId().equals(record.getEmployeeId())).count();
        if (sameEmployee > 1) {
            saveAnomaly(tenantId, record.getId(), record.getEmployeeId(),
                    "duplicate_payroll", "medium",
                    "Employee has multiple payroll records for period " + record.getPeriod());
        }

        // Unusually high tax
        if (record.getGrossSalary() != null && record.getGrossSalary().compareTo(BigDecimal.ZERO) > 0) {
            BigDecimal taxRate = Money.of(record.getTax())
                    .divide(record.getGrossSalary(), 6, java.math.RoundingMode.HALF_UP)
                    .multiply(new BigDecimal("100"));
            if (taxRate.compareTo(new BigDecimal("45")) > 0) {
                saveAnomaly(tenantId, record.getId(), record.getEmployeeId(),
                        "high_tax_rate", "medium",
                        "Tax rate of " + taxRate.setScale(1, java.math.RoundingMode.HALF_UP) + "% exceeds 45% threshold");
            }
        }

        // Zero or negative net salary
        if (record.getNetSalary() == null || record.getNetSalary().compareTo(BigDecimal.ZERO) <= 0) {
            saveAnomaly(tenantId, record.getId(), record.getEmployeeId(),
                    "negative_net_salary", "critical",
                    "Net salary is " + record.getNetSalary() + " for employee " + record.getEmployeeId());
        }
    }

    private void saveAnomaly(String tenantId, Long payrollId, String employeeId,
                              String type, String severity, String description) {
        PayrollAnomaly anomaly = new PayrollAnomaly();
        anomaly.setTenantId(tenantId);
        anomaly.setPayrollId(payrollId);
        anomaly.setEmployeeId(employeeId);
        anomaly.setAnomalyType(type);
        anomaly.setSeverity(severity);
        anomaly.setDescription(description);
        anomaly.setIsResolved(false);
        anomaly.setDetectedAt(LocalDateTime.now());
        anomaly.setCreatedAt(LocalDateTime.now());
        anomalyRepo.save(anomaly);
    }

    // ============================================================
    // 15. DASHBOARD / SUMMARY
    // ============================================================

    public Map<String, Object> getDashboardSummary(String tenantId) {
        List<EnhancedPayrollRecord> all = payrollRepo.findByTenantId(tenantId);
        BigDecimal totalGross = all.stream()
                .map(EnhancedPayrollRecord::getGrossSalary)
                .map(Money::of)
                .reduce(Money.zero(), BigDecimal::add);
        BigDecimal totalNet = all.stream()
                .map(EnhancedPayrollRecord::getNetSalary)
                .map(Money::of)
                .reduce(Money.zero(), BigDecimal::add);
        BigDecimal totalTax = all.stream()
                .map(EnhancedPayrollRecord::getTax)
                .map(Money::of)
                .reduce(Money.zero(), BigDecimal::add);
        long pendingExpenses = expenseRepo.findByTenantIdAndStatus(tenantId, "PENDING").size();
        long anomalies = anomalyRepo.findByTenantIdAndIsResolved(tenantId, false).size();
        long pendingBonuses = bonusRepo.findByTenantIdAndStatus(tenantId, "PENDING").size();

        return Map.of(
                "totalPayrollRecords", all.size(),
                "totalGrossPayroll", totalGross,
                "totalNetPayroll", totalNet,
                "totalTaxWithheld", totalTax,
                "pendingExpenses", pendingExpenses,
                "unresolvedAnomalies", anomalies,
                "pendingBonuses", pendingBonuses
        );
    }

    // ============================================================
    // BATCH PAYROLL PROCESSING (10K employees)
    // ============================================================

    private static final int BATCH_SIZE = 500;

    public Map<String, Object> runBatchPayroll(String tenantId, String period, List<String> employeeIds,
                                                BigDecimal baseSalary, BigDecimal allowances, BigDecimal deductions,
                                                String country, String currency) {
        int total = employeeIds.size();
        int processed = 0;
        int failed = 0;
        List<Map<String, Object>> failures = new ArrayList<>();
        long startTime = System.currentTimeMillis();

        for (int i = 0; i < total; i += BATCH_SIZE) {
            int end = Math.min(i + BATCH_SIZE, total);
            List<String> batch = employeeIds.subList(i, end);

            try {
                for (String empId : batch) {
                    try {
                        runMultiCountryPayroll(tenantId, empId, period, baseSalary, allowances, deductions, country, currency);
                        processed++;
                    } catch (Exception e) {
                        failed++;
                        Map<String, Object> err = new HashMap<>();
                        err.put("employeeId", empId);
                        err.put("error", e.getMessage());
                        err.put("batch", i / BATCH_SIZE);
                        failures.add(err);
                    }
                }
            } catch (Exception e) {
                failed += batch.size();
                for (String empId : batch) {
                    Map<String, Object> err = new HashMap<>();
                    err.put("employeeId", empId);
                    err.put("error", "Batch transaction failed: " + e.getMessage());
                    err.put("batch", i / BATCH_SIZE);
                    failures.add(err);
                }
            }

            updateBatchProgress(tenantId, period, processed, failed, total);
        }

        long duration = System.currentTimeMillis() - startTime;
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("totalEmployees", total);
        result.put("processed", processed);
        result.put("failed", failed);
        result.put("batches", (int) Math.ceil((double) total / BATCH_SIZE));
        result.put("durationMs", duration);
        result.put("failures", failures);
        return result;
    }

    private void updateBatchProgress(String tenantId, String period, int processed, int failed, int total) {
        PayrollAudit audit = new PayrollAudit();
        audit.setTenantId(tenantId);
        audit.setPayrollId(0L);
        audit.setAction("BATCH_PROGRESS");
        audit.setChangedBy("system");
        audit.setOldValue("");
        audit.setNewValue("processed=" + processed + ",failed=" + failed + ",total=" + total + ",period=" + period);
        audit.setChangedAt(LocalDateTime.now());
        auditRepo.save(audit);
    }

    public List<Map<String, Object>> verifyPayrollConsistency(String tenantId, String period) {
        List<EnhancedPayrollRecord> payrollRecords = payrollRepo.findByTenantIdAndPeriod(tenantId, period);
        Set<String> paidEmployees = payrollRecords.stream()
                .map(EnhancedPayrollRecord::getEmployeeId)
                .collect(Collectors.toSet());

        // Cross-reference with attendance data via bank transactions as proxy
        List<BankTransaction> bankTxns = bankRepo.findByTenantId(tenantId);
        Set<String> attendanceEmployees = bankTxns.stream()
                .filter(tx -> "PAYROLL_DIRECT_DEPOSIT".equals(tx.getTransactionType()))
                .map(BankTransaction::getEmployeeId)
                .collect(Collectors.toSet());

        List<Map<String, Object>> discrepancies = new ArrayList<>();

        for (String empId : paidEmployees) {
            if (!attendanceEmployees.contains(empId)) {
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("type", "PAID_NO_ATTENDANCE");
                d.put("employeeId", empId);
                d.put("detail", "Employee has payroll record but no attendance data for period " + period);
                discrepancies.add(d);
            }
        }

        for (String empId : attendanceEmployees) {
            if (!paidEmployees.contains(empId)) {
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("type", "ATTENDANCE_NO_PAY");
                d.put("employeeId", empId);
                d.put("detail", "Employee has attendance data but no payroll record for period " + period);
                discrepancies.add(d);
            }
        }

        return discrepancies;
    }

    // ============================================================
    // EMPLOYEE VALIDATION
    // ============================================================

    private void validateEmployeeExists(String tenantId, String employeeId) {
        boolean exists = !payrollRepo.findByTenantIdAndEmployeeId(tenantId, employeeId).isEmpty()
                || !expenseRepo.findByTenantIdAndEmployeeId(tenantId, employeeId).isEmpty()
                || !bonusRepo.findByTenantIdAndEmployeeId(tenantId, employeeId).isEmpty();
        if (!exists) {
            throw new IllegalArgumentException("Employee not found: " + employeeId);
        }
    }

    // ============================================================
    // GETTERS FOR CONTROLLER
    // ============================================================

    public List<EnhancedPayrollRecord> getAllPayrolls(String tenantId) {
        return payrollRepo.findByTenantId(tenantId);
    }

    public List<EnhancedPayrollRecord> getPayrollsByEmployee(String tenantId, String employeeId) {
        return payrollRepo.findByTenantIdAndEmployeeId(tenantId, employeeId);
    }

    public List<EnhancedPayrollRecord> getPayrollsByPeriod(String tenantId, String period) {
        return payrollRepo.findByTenantIdAndPeriod(tenantId, period);
    }

    public List<CountryTaxConfig> getTaxConfigs(String tenantId) {
        return taxConfigRepo.findByTenantId(tenantId);
    }

    public CountryTaxConfig saveTaxConfig(CountryTaxConfig config) {
        if (config.getCreatedAt() == null) config.setCreatedAt(LocalDateTime.now());
        config.setUpdatedAt(LocalDateTime.now());
        return taxConfigRepo.save(config);
    }

    public List<TaxBracket> getTaxBrackets(String tenantId) {
        return taxBracketRepo.findByTenantId(tenantId);
    }

    public TaxBracket saveTaxBracket(TaxBracket bracket) {
        return taxBracketRepo.save(bracket);
    }

    public List<ExpenseReport> getExpenses(String tenantId) {
        return expenseRepo.findByTenantId(tenantId);
    }

    public List<ExpenseReport> getExpensesByEmployee(String tenantId, String employeeId) {
        return expenseRepo.findByTenantIdAndEmployeeId(tenantId, employeeId);
    }

    public List<BenefitPlan> getBenefitPlans(String tenantId) {
        return benefitPlanRepo.findByTenantId(tenantId);
    }

    public List<BenefitEnrollment> getBenefitEnrollments(String tenantId) {
        return benefitEnrollRepo.findByTenantId(tenantId);
    }

    public List<BenefitEnrollment> getEmployeeBenefits(String tenantId, String employeeId) {
        return benefitEnrollRepo.findByTenantIdAndEmployeeId(tenantId, employeeId);
    }

    public List<Bonus> getBonuses(String tenantId) {
        return bonusRepo.findByTenantId(tenantId);
    }

    public List<Bonus> getEmployeeBonuses(String tenantId, String employeeId) {
        return bonusRepo.findByTenantIdAndEmployeeId(tenantId, employeeId);
    }

    public List<EquityGrant> getEquityGrants(String tenantId) {
        return equityRepo.findByTenantId(tenantId);
    }

    public List<EquityGrant> getEmployeeEquity(String tenantId, String employeeId) {
        return equityRepo.findByTenantIdAndEmployeeId(tenantId, employeeId);
    }

    public List<CompensationPlan> getCompensationPlans(String tenantId) {
        return compensationRepo.findByTenantId(tenantId);
    }

    public List<CompensationPlan> getEmployeeCompensation(String tenantId, String employeeId) {
        return compensationRepo.findByTenantIdAndEmployeeId(tenantId, employeeId);
    }

    public List<SalaryBenchmark> getBenchmarks(String tenantId) {
        return benchmarkRepo.findByTenantId(tenantId);
    }

    public List<PayrollForecast> getForecasts(String tenantId) {
        return forecastRepo.findByTenantId(tenantId);
    }

    public List<BankTransaction> getBankTransactions(String tenantId) {
        return bankRepo.findByTenantId(tenantId);
    }

    public List<PayrollComplianceReport> getComplianceReports(String tenantId) {
        return complianceRepo.findByTenantId(tenantId);
    }

    public List<PayrollAnomaly> getAnomalies(String tenantId) {
        return anomalyRepo.findByTenantId(tenantId);
    }

    public PayrollAnomaly resolveAnomaly(Long id, String tenantId) {
        PayrollAnomaly anomaly = anomalyRepo.findById(id).orElseThrow(
                () -> new IllegalArgumentException("Anomaly not found"));
        anomaly.setIsResolved(true);
        anomaly.setResolvedAt(LocalDateTime.now());
        return anomalyRepo.save(anomaly);
    }

    public List<Payslip> getPayslips(String tenantId) {
        return payslipRepo.findByTenantId(tenantId);
    }

    public List<Payslip> getEmployeePayslips(String tenantId, String employeeId) {
        return payslipRepo.findByTenantIdAndEmployeeId(tenantId, employeeId);
    }

    private static String toJson(Map<String, Object> payload) {
        try {
            return MAPPER.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Failed to serialize outbox payload", e);
        }
    }
}
