package com.ems.payroll.util;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

/**
 * Central helper for monetary calculations.
 *
 * <p>All money in payroll is kept as {@link BigDecimal} with scale 2 and
 * {@link RoundingMode#HALF_UP}. Percentages and rates (tax rates, social
 * security rates, confidence scores) stay as {@code double} because they are
 * statistical inputs, not money. They are converted to money only through
 * {@link #percentOf(BigDecimal, double)} which applies the scale and rounding
 * in one place.
 */
public final class Money {

    public static final int SCALE = 2;
    public static final RoundingMode ROUNDING = RoundingMode.HALF_UP;

    private Money() {
    }

    public static BigDecimal of(Object value) {
        if (value == null) {
            return zero();
        }
        if (value instanceof BigDecimal) {
            return ((BigDecimal) value).setScale(SCALE, ROUNDING);
        }
        if (value instanceof Number) {
            // Use the string form so 0.1 stays 0.10 instead of 0.1000000000000000055.
            return new BigDecimal(value.toString()).setScale(SCALE, ROUNDING);
        }
        return new BigDecimal(value.toString()).setScale(SCALE, ROUNDING);
    }

    public static BigDecimal zero() {
        return BigDecimal.ZERO.setScale(SCALE, ROUNDING);
    }

    public static BigDecimal add(BigDecimal a, BigDecimal b) {
        return of(a).add(of(b)).setScale(SCALE, ROUNDING);
    }

    public static BigDecimal subtract(BigDecimal a, BigDecimal b) {
        return of(a).subtract(of(b)).setScale(SCALE, ROUNDING);
    }

    /**
     * Apply a fractional rate (for example 0.0765 for 7.65%) to a money amount.
     */
    public static BigDecimal percentOf(BigDecimal amount, double rate) {
        if (rate == 0) {
            return zero();
        }
        return of(amount)
                .multiply(BigDecimal.valueOf(rate))
                .setScale(SCALE, ROUNDING);
    }

    public static BigDecimal sum(List<BigDecimal> values) {
        BigDecimal total = zero();
        if (values == null) {
            return total;
        }
        for (BigDecimal v : values) {
            total = total.add(of(v));
        }
        return total.setScale(SCALE, ROUNDING);
    }
}
