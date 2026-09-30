package com.ems.payroll.util;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class MoneyTest {

    @Test
    void tenthPlusFifthIsExact() {
        // The classic 0.1 + 0.2 case must be exactly 0.30, not 0.30000000000000004.
        assertEquals(new BigDecimal("0.30"), Money.add(new BigDecimal("0.10"), new BigDecimal("0.20")));
    }

    @Test
    void awkwardSplitRoundsToCents() {
        assertEquals(new BigDecimal("333.33"), Money.of("333.333"));
        assertEquals(new BigDecimal("333.33"), Money.of(333.333));
    }

    @Test
    void statutoryDeductionIsExactToTheCent() {
        // 1234.56 with a 7.65% deduction is 94.44 after HALF_UP rounding.
        assertEquals(new BigDecimal("94.44"), Money.percentOf(new BigDecimal("1234.56"), 0.0765));
    }

    @Test
    void sumMatchesTotalToTheCent() {
        BigDecimal total = Money.sum(List.of(
                new BigDecimal("100.10"),
                new BigDecimal("200.20"),
                new BigDecimal("333.33")));
        assertEquals(new BigDecimal("633.63"), total);
    }
}
