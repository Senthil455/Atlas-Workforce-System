package com.ems.payroll.controller;

import com.ems.payroll.model.*;
import com.atlas.common.security.RequiresRole;
import com.ems.payroll.service.PayrollEnterpriseService;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/payroll/enterprise")
@CrossOrigin(origins = "${ALLOWED_ORIGINS:http://localhost:3000}")
@Validated
public class PayrollEnterpriseController {

    private final PayrollEnterpriseService service;

    public PayrollEnterpriseController(PayrollEnterpriseService service) {
        this.service = service;
    }

    // ============================================================
    // Dashboard
    // ============================================================
    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/dashboard")
    public ResponseEntity<Map<String, Object>> getDashboard(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getDashboardSummary(tenantId));
    }

    // ============================================================
    // Multi-country payroll
    // ============================================================
    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/payrolls")
    public ResponseEntity<List<EnhancedPayrollRecord>> getPayrolls(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getAllPayrolls(tenantId));
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/payrolls/employee/{employeeId}")
    public ResponseEntity<List<EnhancedPayrollRecord>> getPayrollsByEmployee(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @PathVariable String employeeId) {
        return ResponseEntity.ok(service.getPayrollsByEmployee(tenantId, employeeId));
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/payrolls/period/{period}")
    public ResponseEntity<List<EnhancedPayrollRecord>> getPayrollsByPeriod(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @PathVariable String period) {
        return ResponseEntity.ok(service.getPayrollsByPeriod(tenantId, period));
    }

    @RequiresRole({"admin"})
    @PostMapping("/payrolls/run")
    public ResponseEntity<?> runPayroll(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        try {
            EnhancedPayrollRecord record = service.runMultiCountryPayroll(
                    tenantId,
                    (String) req.get("employeeId"),
                    (String) req.get("period"),
                    Double.valueOf(req.getOrDefault("baseSalary", "0").toString()),
                    Double.valueOf(req.getOrDefault("allowances", "0").toString()),
                    Double.valueOf(req.getOrDefault("deductions", "0").toString()),
                    (String) req.getOrDefault("country", "US"),
                    (String) req.getOrDefault("currency", "USD"));
            return ResponseEntity.ok(record);
        } catch (Exception e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    // ============================================================
    // Tax config
    // ============================================================
    @RequiresRole({"admin", "hr"})
    @GetMapping("/tax-configs")
    public ResponseEntity<List<CountryTaxConfig>> getTaxConfigs(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getTaxConfigs(tenantId));
    }

    @RequiresRole({"admin"})
    @PostMapping("/tax-configs")
    public ResponseEntity<CountryTaxConfig> saveTaxConfig(
            @RequestBody CountryTaxConfig config) {
        return ResponseEntity.ok(service.saveTaxConfig(config));
    }

    @RequiresRole({"admin", "hr"})
    @GetMapping("/tax-brackets")
    public ResponseEntity<List<TaxBracket>> getTaxBrackets(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getTaxBrackets(tenantId));
    }

    @RequiresRole({"admin"})
    @PostMapping("/tax-brackets")
    public ResponseEntity<TaxBracket> saveTaxBracket(
            @RequestBody TaxBracket bracket) {
        return ResponseEntity.ok(service.saveTaxBracket(bracket));
    }

    // ============================================================
    // Tax simulations
    // ============================================================
    @RequiresRole({"admin", "hr"})
    @PostMapping("/tax/simulate")
    public ResponseEntity<Map<String, Object>> simulateTax(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        String country = (String) req.getOrDefault("country", "US");
        Double grossSalary = Double.valueOf(req.getOrDefault("grossSalary", "0").toString());
        return ResponseEntity.ok(service.simulateTax(tenantId, country, grossSalary));
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/tax/compare")
    public ResponseEntity<List<Map<String, Object>>> compareTax(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        @SuppressWarnings("unchecked")
        List<String> countries = (List<String>) req.getOrDefault("countries", List.of("US"));
        Double grossSalary = Double.valueOf(req.getOrDefault("grossSalary", "0").toString());
        return ResponseEntity.ok(service.compareCountryTax(tenantId, countries, grossSalary));
    }

    // ============================================================
    // Payroll forecasting
    // ============================================================
    @RequiresRole({"admin", "hr"})
    @PostMapping("/forecasts/generate")
    public ResponseEntity<PayrollForecast> generateForecast(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, String> req) {
        String period = req.getOrDefault("period", "2026-Q2");
        return ResponseEntity.ok(service.generateForecast(tenantId, period));
    }

    @RequiresRole({"admin", "hr"})
    @GetMapping("/forecasts")
    public ResponseEntity<List<PayrollForecast>> getForecasts(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getForecasts(tenantId));
    }

    // ============================================================
    // Payroll auditing
    // ============================================================
    @RequiresRole({"admin", "hr"})
    @GetMapping("/audit-logs")
    public ResponseEntity<List<PayrollAudit>> getAuditLogs(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getAuditLogs(tenantId));
    }

    // ============================================================
    // Payslip generation
    // ============================================================
    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/payslips")
    public ResponseEntity<List<Payslip>> getPayslips(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getPayslips(tenantId));
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/payslips/employee/{employeeId}")
    public ResponseEntity<List<Payslip>> getEmployeePayslips(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @PathVariable String employeeId) {
        return ResponseEntity.ok(service.getEmployeePayslips(tenantId, employeeId));
    }

    // ============================================================
    // Bank integration
    // ============================================================
    @RequiresRole({"admin"})
    @PostMapping("/bank/transactions")
    public ResponseEntity<BankTransaction> createBankTransaction(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        BankTransaction tx = service.createBankTransaction(
                tenantId,
                Long.valueOf(req.getOrDefault("payrollId", "0").toString()),
                (String) req.get("employeeId"),
                Double.valueOf(req.getOrDefault("amount", "0").toString()),
                (String) req.get("accountNumber"),
                (String) req.get("routingNumber"),
                (String) req.getOrDefault("bankName", ""));
        return ResponseEntity.ok(tx);
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/bank/transactions")
    public ResponseEntity<List<BankTransaction>> getBankTransactions(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getBankTransactions(tenantId));
    }

    @RequiresRole({"admin"})
    @PostMapping("/bank/transactions/{id}/process")
    public ResponseEntity<BankTransaction> processBankTransaction(@PathVariable Long id) {
        return ResponseEntity.ok(service.processBankTransaction(id));
    }

    // ============================================================
    // Expense reimbursements
    // ============================================================
    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/expenses")
    public ResponseEntity<List<ExpenseReport>> getExpenses(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getExpenses(tenantId));
    }

    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/expenses/employee/{employeeId}")
    public ResponseEntity<List<ExpenseReport>> getExpensesByEmployee(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @PathVariable String employeeId) {
        return ResponseEntity.ok(service.getExpensesByEmployee(tenantId, employeeId));
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @PostMapping("/expenses")
    public ResponseEntity<ExpenseReport> submitExpense(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        ExpenseReport expense = service.submitExpense(
                tenantId,
                (String) req.get("employeeId"),
                (String) req.get("category"),
                Double.valueOf(req.getOrDefault("amount", "0").toString()),
                (String) req.getOrDefault("description", ""),
                (String) req.getOrDefault("receiptUrl", ""));
        return ResponseEntity.ok(expense);
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/expenses/{id}/approve")
    public ResponseEntity<ExpenseReport> approveExpense(
            @PathVariable Long id,
            @RequestBody Map<String, String> req) {
        return ResponseEntity.ok(service.approveExpense(id, req.getOrDefault("approvedBy", "admin")));
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/expenses/{id}/reject")
    public ResponseEntity<ExpenseReport> rejectExpense(
            @PathVariable Long id,
            @RequestBody Map<String, String> req) {
        return ResponseEntity.ok(service.rejectExpense(id, req.getOrDefault("reason", "No reason provided")));
    }

    // ============================================================
    // Benefits administration
    // ============================================================
    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/benefit-plans")
    public ResponseEntity<List<BenefitPlan>> getBenefitPlans(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getBenefitPlans(tenantId));
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/benefit-plans")
    public ResponseEntity<BenefitPlan> createBenefitPlan(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        BenefitPlan plan = service.createBenefitPlan(
                tenantId,
                (String) req.get("name"),
                (String) req.get("type"),
                (String) req.getOrDefault("description", ""),
                Double.valueOf(req.getOrDefault("employerContribution", "0").toString()),
                Double.valueOf(req.getOrDefault("employeeContribution", "0").toString()),
                Double.valueOf(req.getOrDefault("maxBenefitAmount", "0").toString()));
        return ResponseEntity.ok(plan);
    }

    @RequiresRole({"admin", "hr", "manager", "employee"})
    @GetMapping("/benefit-enrollments")
    public ResponseEntity<List<BenefitEnrollment>> getBenefitEnrollments(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getBenefitEnrollments(tenantId));
    }

    @RequiresRole({"admin", "hr", "employee"})
    @PostMapping("/benefit-enrollments")
    public ResponseEntity<BenefitEnrollment> enrollBenefit(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        return ResponseEntity.ok(service.enrollInBenefit(
                tenantId,
                (String) req.get("employeeId"),
                Long.valueOf(req.get("planId").toString())));
    }

    // ============================================================
    // Compensation planning
    // ============================================================
    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/compensation-plans")
    public ResponseEntity<List<CompensationPlan>> getCompensationPlans(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getCompensationPlans(tenantId));
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/compensation-plans")
    public ResponseEntity<CompensationPlan> createCompensationPlan(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        CompensationPlan plan = service.createCompensationPlan(
                tenantId,
                (String) req.get("employeeId"),
                Double.valueOf(req.getOrDefault("currentSalary", "0").toString()),
                Double.valueOf(req.getOrDefault("proposedSalary", "0").toString()),
                (String) req.getOrDefault("currency", "USD"),
                (String) req.getOrDefault("reason", ""),
                (String) req.getOrDefault("reviewCycle", "annual"));
        return ResponseEntity.ok(plan);
    }

    // ============================================================
    // Bonus management
    // ============================================================
    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/bonuses")
    public ResponseEntity<List<Bonus>> getBonuses(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getBonuses(tenantId));
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/bonuses")
    public ResponseEntity<Bonus> createBonus(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        Bonus bonus = service.createBonus(
                tenantId,
                (String) req.get("employeeId"),
                Double.valueOf(req.getOrDefault("amount", "0").toString()),
                (String) req.getOrDefault("type", "performance"),
                (String) req.getOrDefault("reason", ""));
        return ResponseEntity.ok(bonus);
    }

    @RequiresRole({"admin"})
    @PostMapping("/bonuses/{id}/approve")
    public ResponseEntity<Bonus> approveBonus(
            @PathVariable Long id,
            @RequestBody Map<String, String> req) {
        return ResponseEntity.ok(service.approveBonus(id, req.getOrDefault("approvedBy", "admin")));
    }

    // ============================================================
    // Equity management
    // ============================================================
    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/equity")
    public ResponseEntity<List<EquityGrant>> getEquity(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getEquityGrants(tenantId));
    }

    @RequiresRole({"admin"})
    @PostMapping("/equity")
    public ResponseEntity<EquityGrant> createEquityGrant(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        EquityGrant grant = service.createEquityGrant(
                tenantId,
                (String) req.get("employeeId"),
                Double.valueOf(req.getOrDefault("shares", "0").toString()),
                Double.valueOf(req.getOrDefault("strikePrice", "0").toString()),
                Double.valueOf(req.getOrDefault("fairMarketValue", "0").toString()),
                (String) req.getOrDefault("equityType", "NSO"),
                (String) req.getOrDefault("vestingSchedule", "4-year standard"));
        return ResponseEntity.ok(grant);
    }

    @RequiresRole({"admin", "hr", "employee"})
    @GetMapping("/equity/employee/{employeeId}")
    public ResponseEntity<List<EquityGrant>> getEmployeeEquity(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @PathVariable String employeeId) {
        return ResponseEntity.ok(service.getEmployeeEquity(tenantId, employeeId));
    }

    // ============================================================
    // Salary benchmarking
    // ============================================================
    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/benchmarks")
    public ResponseEntity<List<SalaryBenchmark>> getBenchmarks(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getBenchmarks(tenantId));
    }

    @RequiresRole({"admin", "hr"})
    @PostMapping("/benchmarks")
    public ResponseEntity<SalaryBenchmark> addBenchmark(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        SalaryBenchmark benchmark = service.addBenchmark(
                tenantId,
                (String) req.get("role"),
                (String) req.getOrDefault("experience", "mid"),
                (String) req.getOrDefault("location", ""),
                Double.valueOf(req.getOrDefault("p10", "0").toString()),
                Double.valueOf(req.getOrDefault("p25", "0").toString()),
                Double.valueOf(req.getOrDefault("p50", "0").toString()),
                Double.valueOf(req.getOrDefault("p75", "0").toString()),
                Double.valueOf(req.getOrDefault("p90", "0").toString()),
                (String) req.getOrDefault("currency", "USD"),
                (String) req.getOrDefault("source", "internal"));
        return ResponseEntity.ok(benchmark);
    }

    @RequiresRole({"admin", "hr", "manager"})
    @PostMapping("/benchmarks/compare")
    public ResponseEntity<Map<String, Object>> compareBenchmark(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, Object> req) {
        return ResponseEntity.ok(service.compareToBenchmark(
                tenantId,
                (String) req.get("role"),
                (String) req.getOrDefault("experience", "mid"),
                (String) req.getOrDefault("location", ""),
                Double.valueOf(req.getOrDefault("currentSalary", "0").toString())));
    }

    // ============================================================
    // Compliance reports
    // ============================================================
    @RequiresRole({"admin", "hr", "manager"})
    @GetMapping("/compliance-reports")
    public ResponseEntity<List<PayrollComplianceReport>> getComplianceReports(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getComplianceReports(tenantId));
    }

    @RequiresRole({"admin"})
    @PostMapping("/compliance-reports/generate")
    public ResponseEntity<PayrollComplianceReport> generateComplianceReport(
            @RequestHeader("X-Tenant-Id") String tenantId,
            @RequestBody Map<String, String> req) {
        return ResponseEntity.ok(service.generateComplianceReport(
                tenantId,
                req.getOrDefault("reportType", "TAX"),
                req.getOrDefault("period", ""),
                req.getOrDefault("country", "US")));
    }

    // ============================================================
    // Anomaly detection
    // ============================================================
    @RequiresRole({"admin", "hr"})
    @GetMapping("/anomalies")
    public ResponseEntity<List<PayrollAnomaly>> getAnomalies(
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.getAnomalies(tenantId));
    }

    @RequiresRole({"admin"})
    @PostMapping("/anomalies/{id}/resolve")
    public ResponseEntity<PayrollAnomaly> resolveAnomaly(
            @PathVariable Long id,
            @RequestHeader("X-Tenant-Id") String tenantId) {
        return ResponseEntity.ok(service.resolveAnomaly(id, tenantId));
    }
}
