package com.ems.payroll.service;

import com.ems.payroll.model.BankTransaction;
import com.ems.payroll.model.CompensationPlan;
import com.ems.payroll.model.EnhancedPayrollRecord;
import com.ems.payroll.model.OutboxEvent;
import com.ems.payroll.model.PayrollAudit;
import com.ems.payroll.model.PayrollComplianceReport;
import com.ems.payroll.model.PayrollForecast;
import com.ems.payroll.model.Payslip;
import com.ems.payroll.repository.BankTransactionRepository;
import com.ems.payroll.repository.BenefitEnrollmentRepository;
import com.ems.payroll.repository.BenefitPlanRepository;
import com.ems.payroll.repository.BonusRepository;
import com.ems.payroll.repository.CompensationPlanRepository;
import com.ems.payroll.repository.CountryTaxConfigRepository;
import com.ems.payroll.repository.EnhancedPayrollRepository;
import com.ems.payroll.repository.EquityGrantRepository;
import com.ems.payroll.repository.ExpenseReportRepository;
import com.ems.payroll.repository.OutboxEventRepository;
import com.ems.payroll.repository.PayrollAnomalyRepository;
import com.ems.payroll.repository.PayrollAuditRepository;
import com.ems.payroll.repository.PayrollComplianceReportRepository;
import com.ems.payroll.repository.PayrollForecastRepository;
import com.ems.payroll.repository.PayslipRepository;
import com.ems.payroll.repository.SalaryBenchmarkRepository;
import com.ems.payroll.repository.TaxBracketRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PayrollEnterpriseServiceTest {

    @Mock private EnhancedPayrollRepository payrollRepo;
    @Mock private CountryTaxConfigRepository taxConfigRepo;
    @Mock private TaxBracketRepository taxBracketRepo;
    @Mock private PayrollAuditRepository auditRepo;
    @Mock private ExpenseReportRepository expenseRepo;
    @Mock private BenefitPlanRepository benefitPlanRepo;
    @Mock private BenefitEnrollmentRepository benefitEnrollRepo;
    @Mock private BonusRepository bonusRepo;
    @Mock private EquityGrantRepository equityRepo;
    @Mock private CompensationPlanRepository compensationRepo;
    @Mock private SalaryBenchmarkRepository benchmarkRepo;
    @Mock private PayrollForecastRepository forecastRepo;
    @Mock private BankTransactionRepository bankRepo;
    @Mock private PayrollComplianceReportRepository complianceRepo;
    @Mock private PayrollAnomalyRepository anomalyRepo;
    @Mock private PayslipRepository payslipRepo;
    @Mock private OutboxEventRepository outboxEventRepository;

    @InjectMocks
    private PayrollEnterpriseService service;

    // ============================================================
    // Bank transaction idempotency
    // ============================================================

    @Test
    void settledTransactionReplayReturnsTheSameRowWithoutSettlingItAgain() {
        LocalDateTime settledAt = LocalDateTime.of(2026, 1, 2, 3, 4);
        BankTransaction settled = new BankTransaction();
        settled.setId(5L);
        settled.setTenantId("t1");
        settled.setStatus("PROCESSED");
        settled.setProcessedAt(settledAt);
        when(bankRepo.findByIdAndTenantIdForUpdate(5L, "t1")).thenReturn(Optional.of(settled));

        BankTransaction result = service.processBankTransaction(5L, "t1");

        assertSame(settled, result);
        assertEquals("PROCESSED", result.getStatus());
        assertEquals(settledAt, result.getProcessedAt());
        verify(bankRepo, never()).save(any(BankTransaction.class));
    }

    @Test
    void pendingTransactionIsSettledOnce() {
        BankTransaction pending = new BankTransaction();
        pending.setId(6L);
        pending.setTenantId("t1");
        pending.setStatus("PENDING");
        when(bankRepo.findByIdAndTenantIdForUpdate(6L, "t1")).thenReturn(Optional.of(pending));
        when(bankRepo.save(pending)).thenAnswer(inv -> inv.getArgument(0));

        BankTransaction result = service.processBankTransaction(6L, "t1");

        assertEquals("PROCESSED", result.getStatus());
        assertNotNull(result.getProcessedAt());
        verify(bankRepo).save(pending);
    }

    @Test
    void processingIsScopedToTheCallerTenant() {
        when(bankRepo.findByIdAndTenantIdForUpdate(7L, "other-tenant")).thenReturn(Optional.empty());

        assertThrows(IllegalArgumentException.class, () -> service.processBankTransaction(7L, "other-tenant"));

        // The lookup must go through the tenant-scoped finder, never the
        // global one.
        verify(bankRepo, never()).findById(anyLong());
    }

    @Test
    void transactionInANonPendingStateCannotBeProcessed() {
        BankTransaction rejected = new BankTransaction();
        rejected.setId(8L);
        rejected.setStatus("REJECTED");
        when(bankRepo.findByIdAndTenantIdForUpdate(8L, "t1")).thenReturn(Optional.of(rejected));

        assertThrows(IllegalStateException.class, () -> service.processBankTransaction(8L, "t1"));
        verify(bankRepo, never()).save(any(BankTransaction.class));
    }

    @Test
    void repeatedCreateReturnsTheStoredTransferForTheSameReference() {
        BankTransaction existing = new BankTransaction();
        existing.setId(9L);
        existing.setReference("PAY-11-e1");
        when(bankRepo.findByTenantIdAndReference("t1", "PAY-11-e1")).thenReturn(Optional.of(existing));

        BankTransaction result = service.createBankTransaction(
                "t1", 11L, "e1", new BigDecimal("120.00"), "acct", "routing", "bank");

        assertSame(existing, result);
        verify(bankRepo, never()).save(any(BankTransaction.class));
    }

    @Test
    void firstCreateStoresTheDeterministicReference() {
        when(bankRepo.findByTenantIdAndReference("t1", "PAY-11-e1")).thenReturn(Optional.empty());
        when(bankRepo.save(any(BankTransaction.class))).thenAnswer(inv -> inv.getArgument(0));

        BankTransaction created = service.createBankTransaction(
                "t1", 11L, "e1", new BigDecimal("120.00"), "acct", "routing", "bank");

        assertEquals("PAY-11-e1", created.getReference());
        assertEquals("PENDING", created.getStatus());
        assertEquals(new BigDecimal("120.00"), created.getAmount());
    }

    // ============================================================
    // Batch payroll
    // ============================================================

    @Test
    void batchRunResolvesComponentsPerEmployee() {
        stubSuccessfulPayrollPlumbing();
        when(payrollRepo.findByTenantIdAndEmployeeId("t1", "e1"))
                .thenReturn(List.of(payrollRecord(1L, "e1", "5000.00", "100.00", "50.00")));
        when(payrollRepo.findByTenantIdAndEmployeeId("t1", "e2")).thenReturn(List.of());
        when(payrollRepo.findByTenantIdAndEmployeeId("t1", "e3")).thenReturn(List.of());
        when(compensationRepo.findByTenantIdAndEmployeeId("t1", "e1")).thenReturn(List.of());
        when(compensationRepo.findByTenantIdAndEmployeeId("t1", "e2"))
                .thenReturn(List.of(compensationPlan(4L, "e2", "7000.00")));
        when(compensationRepo.findByTenantIdAndEmployeeId("t1", "e3")).thenReturn(List.of());

        Map<String, Object> result = service.runBatchPayroll(
                "t1", "2026-01", List.of("e1", "e2", "e3"),
                new BigDecimal("3000.00"), new BigDecimal("10.00"), new BigDecimal("5.00"), "US", "USD");

        assertEquals(3, ((Number) result.get("processed")).intValue());
        assertEquals(0, ((Number) result.get("failed")).intValue());
        assertTrue(((List<?>) result.get("failures")).isEmpty());

        ArgumentCaptor<EnhancedPayrollRecord> saved = ArgumentCaptor.forClass(EnhancedPayrollRecord.class);
        verify(payrollRepo, org.mockito.Mockito.times(3)).save(saved.capture());
        Map<String, EnhancedPayrollRecord> byEmployee = new java.util.HashMap<>();
        saved.getAllValues().forEach(record -> byEmployee.put(record.getEmployeeId(), record));

        // e1: carried forward from the most recent payroll record.
        assertEquals(new BigDecimal("5000.00"), byEmployee.get("e1").getBaseSalary());
        assertEquals(new BigDecimal("100.00"), byEmployee.get("e1").getAllowances());
        assertEquals(new BigDecimal("50.00"), byEmployee.get("e1").getDeductions());
        // e2: resolved from the compensation plan, batch values for the rest.
        assertEquals(new BigDecimal("7000.00"), byEmployee.get("e2").getBaseSalary());
        assertEquals(new BigDecimal("10.00"), byEmployee.get("e2").getAllowances());
        // e3: nothing on file, falls back to the batch request values.
        assertEquals(new BigDecimal("3000.00"), byEmployee.get("e3").getBaseSalary());
        assertEquals(new BigDecimal("5.00"), byEmployee.get("e3").getDeductions());

        // A clean run records progress exactly once.
        assertEquals(1, countAuditRows("BATCH_PROGRESS"));
    }

    @Test
    void batchRunWithFailuresDoesNotRecordProgress() {
        stubSuccessfulPayrollPlumbing();
        // e1 already has a payroll record for the period: the run fails for it.
        when(payrollRepo.findByTenantIdAndEmployeeIdAndPeriod("t1", "e1", "2026-01"))
                .thenReturn(List.of(payrollRecord(2L, "e1", "5000.00", "0.00", "0.00")));
        when(payrollRepo.findByTenantIdAndEmployeeId(anyString(), anyString())).thenReturn(List.of());
        when(compensationRepo.findByTenantIdAndEmployeeId(anyString(), anyString())).thenReturn(List.of());

        Map<String, Object> result = service.runBatchPayroll(
                "t1", "2026-01", List.of("e1", "e2"),
                new BigDecimal("3000.00"), new BigDecimal("10.00"), new BigDecimal("5.00"), "US", "USD");

        assertEquals(1, ((Number) result.get("processed")).intValue());
        assertEquals(1, ((Number) result.get("failed")).intValue());
        assertEquals(1, ((List<?>) result.get("failures")).size());
        assertEquals(0, countAuditRows("BATCH_PROGRESS"));
    }

    // ============================================================
    // Consistency check
    // ============================================================

    @Test
    void consistencyCheckUsesThePeriodFilteredBankQuery() {
        when(payrollRepo.findByTenantIdAndPeriod("t1", "2026-01"))
                .thenReturn(List.of(payrollRecord(10L, "e1", "5000.00", "0.00", "0.00")));
        when(bankRepo.findPayrollDepositsByTenantIdAndTypeAndPeriod("t1", "PAYROLL_DIRECT_DEPOSIT", "2026-01"))
                .thenReturn(List.of());
        // A deposit for another period exists in the ledger; the old unfiltered
        // query would have pulled it in. The period-scoped finder must win.
        BankTransaction otherPeriod = new BankTransaction();
        otherPeriod.setId(99L);
        otherPeriod.setEmployeeId("e9");
        otherPeriod.setPayrollId(999L);
        lenient().when(bankRepo.findByTenantId("t1")).thenReturn(List.of(otherPeriod));

        List<Map<String, Object>> discrepancies = service.verifyPayrollConsistency("t1", "2026-01");

        assertEquals(1, discrepancies.size());
        assertEquals("PAID_NO_BANK_DEPOSIT", discrepancies.get(0).get("type"));
        assertEquals("e1", discrepancies.get(0).get("employeeId"));
        verify(bankRepo, never()).findByTenantId(anyString());
    }

    @Test
    void consistencyCheckFlagsDepositsWithoutPayroll() {
        when(payrollRepo.findByTenantIdAndPeriod("t1", "2026-01")).thenReturn(List.of());
        BankTransaction deposit = new BankTransaction();
        deposit.setId(20L);
        deposit.setEmployeeId("e2");
        deposit.setPayrollId(30L);
        deposit.setTransactionType("PAYROLL_DIRECT_DEPOSIT");
        when(bankRepo.findPayrollDepositsByTenantIdAndTypeAndPeriod("t1", "PAYROLL_DIRECT_DEPOSIT", "2026-01"))
                .thenReturn(List.of(deposit));

        List<Map<String, Object>> discrepancies = service.verifyPayrollConsistency("t1", "2026-01");

        assertEquals(1, discrepancies.size());
        assertEquals("BANK_DEPOSIT_NO_PAY", discrepancies.get(0).get("type"));
        assertEquals("e2", discrepancies.get(0).get("employeeId"));
    }

    // ============================================================
    // Externalized configuration
    // ============================================================

    @Test
    void forecastUsesConfiguredGrowthAndRates() {
        ReflectionTestUtils.setField(service, "forecastGrossGrowthRate", 1.10);
        ReflectionTestUtils.setField(service, "forecastTaxRate", 0.20);
        ReflectionTestUtils.setField(service, "forecastBenefitsRate", 0.05);
        ReflectionTestUtils.setField(service, "forecastConfidence", 90.0);
        when(payrollRepo.sumGrossSalaryByTenant("t1")).thenReturn(new BigDecimal("1000.00"));
        when(forecastRepo.save(any(PayrollForecast.class))).thenAnswer(inv -> inv.getArgument(0));

        PayrollForecast forecast = service.generateForecast("t1", "2026-Q1");

        assertEquals(new BigDecimal("1100.00"), forecast.getProjectedGrossPayroll());
        assertEquals(new BigDecimal("220.00"), forecast.getProjectedTax());
        assertEquals(new BigDecimal("880.00"), forecast.getProjectedNetPayroll());
        assertEquals(new BigDecimal("55.00"), forecast.getProjectedBenefits());
        assertEquals(90.0, forecast.getConfidence());
        assertTrue(forecast.getFactors().contains("10% growth"));
    }

    @Test
    void forecastDefaultsKeepTheHistoricalMath() {
        when(payrollRepo.sumGrossSalaryByTenant("t1")).thenReturn(new BigDecimal("1000.00"));
        when(forecastRepo.save(any(PayrollForecast.class))).thenAnswer(inv -> inv.getArgument(0));

        PayrollForecast forecast = service.generateForecast("t1", "2026-Q1");

        assertEquals(new BigDecimal("1030.00"), forecast.getProjectedGrossPayroll());
        assertEquals(new BigDecimal("257.50"), forecast.getProjectedTax());
        assertEquals(new BigDecimal("772.50"), forecast.getProjectedNetPayroll());
        assertEquals(new BigDecimal("82.40"), forecast.getProjectedBenefits());
        assertEquals(85.0, forecast.getConfidence());
        assertTrue(forecast.getFactors().contains("3% growth"));
    }

    @Test
    void complianceReportUsesConfiguredStatutoryRates() {
        ReflectionTestUtils.setField(service, "complianceSocialSecurityRate", 0.10);
        ReflectionTestUtils.setField(service, "complianceMedicareRate", 0.02);
        when(payrollRepo.sumBaseSalaryByTenantAndPeriod("t1", "2026-01")).thenReturn(new BigDecimal("1000.00"));
        when(auditRepo.save(any(PayrollAudit.class))).thenAnswer(inv -> inv.getArgument(0));
        when(complianceRepo.save(any(PayrollComplianceReport.class))).thenAnswer(inv -> inv.getArgument(0));

        PayrollComplianceReport report = service.generateComplianceReport("t1", "SOCIAL_SECURITY", "2026-01", "US");

        assertTrue(report.getDetails().contains("Social Security Due: 100.00"));
        assertTrue(report.getDetails().contains("Medicare Due: 20.00"));
    }

    // ============================================================
    // Helpers
    // ============================================================

    /**
     * Stubs the plumbing every successful payroll run touches: no duplicate
     * found, no tax config, saved rows get ids, payslip and audit writes
     * echo their argument.
     */
    private void stubSuccessfulPayrollPlumbing() {
        when(payrollRepo.findByTenantIdAndEmployeeIdAndPeriod(anyString(), anyString(), anyString()))
                .thenReturn(List.of());
        when(payrollRepo.findByTenantIdAndPeriod(anyString(), anyString())).thenReturn(List.of());
        when(taxConfigRepo.findByTenantIdAndCountry(anyString(), anyString())).thenReturn(Optional.empty());
        AtomicLong ids = new AtomicLong(100);
        when(payrollRepo.save(any(EnhancedPayrollRecord.class))).thenAnswer(inv -> {
            EnhancedPayrollRecord saved = inv.getArgument(0);
            saved.setId(ids.incrementAndGet());
            return saved;
        });
        when(payslipRepo.findByPayrollId(anyLong())).thenReturn(Optional.empty());
        when(payslipRepo.save(any(Payslip.class))).thenAnswer(inv -> inv.getArgument(0));
        when(auditRepo.save(any(PayrollAudit.class))).thenAnswer(inv -> inv.getArgument(0));
        when(outboxEventRepository.save(any(OutboxEvent.class))).thenAnswer(inv -> inv.getArgument(0));
    }

    private long countAuditRows(String action) {
        ArgumentCaptor<PayrollAudit> audits = ArgumentCaptor.forClass(PayrollAudit.class);
        verify(auditRepo, atLeastOnce()).save(audits.capture());
        return audits.getAllValues().stream().filter(audit -> action.equals(audit.getAction())).count();
    }

    private static EnhancedPayrollRecord payrollRecord(long id, String employeeId, String base,
                                                        String allowances, String deductions) {
        EnhancedPayrollRecord record = new EnhancedPayrollRecord();
        record.setId(id);
        record.setTenantId("t1");
        record.setEmployeeId(employeeId);
        record.setPeriod("2025-12");
        record.setBaseSalary(new BigDecimal(base));
        record.setAllowances(new BigDecimal(allowances));
        record.setDeductions(new BigDecimal(deductions));
        return record;
    }

    private static CompensationPlan compensationPlan(long id, String employeeId, String proposedBaseSalary) {
        CompensationPlan plan = new CompensationPlan();
        plan.setId(id);
        plan.setTenantId("t1");
        plan.setEmployeeId(employeeId);
        plan.setProposedBaseSalary(new BigDecimal(proposedBaseSalary));
        plan.setStatus("PENDING");
        return plan;
    }
}
