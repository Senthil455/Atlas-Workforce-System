package com.ems.payroll;

import com.ems.payroll.repository.OutboxEventRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.math.BigDecimal;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PayrollServiceTest {

    @Mock
    private PayrollRepository repository;

    @Mock
    private OutboxEventRepository outboxEventRepository;

    @InjectMocks
    private PayrollService service;

    @Test
    void runPayrollKeepsCentsExact() {
        when(repository.findByTenantIdAndEmployeeIdAndPeriod("t1", "e1", "2026-01"))
                .thenReturn(List.of());
        when(repository.save(any(PayrollRecord.class)))
                .thenAnswer(inv -> inv.getArgument(0));

        // 0.10 + 0.20 - 0.00 = 0.30 gross, below the 3000 tax threshold.
        PayrollRecord record = service.runPayroll(
                "t1", "e1", "2026-01",
                new BigDecimal("0.10"), new BigDecimal("0.20"), new BigDecimal("0.00"));

        assertEquals(new BigDecimal("0.30"), record.getNetSalary());
        assertEquals(new BigDecimal("0.00"), record.getTax());
    }

    @Test
    void awkwardSalaryProducesExactTaxAndNet() {
        when(repository.findByTenantIdAndEmployeeIdAndPeriod("t1", "e2", "2026-01"))
                .thenReturn(List.of());
        when(repository.save(any(PayrollRecord.class)))
                .thenAnswer(inv -> inv.getArgument(0));

        // 5000 gross: (5000 - 3000) * 15% = 300.00 tax, 4700.00 net.
        PayrollRecord record = service.runPayroll(
                "t1", "e2", "2026-01",
                new BigDecimal("4000.00"), new BigDecimal("1000.00"), new BigDecimal("0.00"));

        assertEquals(new BigDecimal("300.00"), record.getTax());
        assertEquals(new BigDecimal("4700.00"), record.getNetSalary());
    }

    @Test
    void batchSumsMatchTotalToTheCent() {
        java.math.BigDecimal total = com.ems.payroll.util.Money.sum(List.of(
                new BigDecimal("1234.56"),
                new BigDecimal("333.33"),
                new BigDecimal("0.10")));
        assertEquals(new BigDecimal("1567.99"), total);
    }
}
