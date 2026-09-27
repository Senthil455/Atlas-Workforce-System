-- Migrate money columns from DOUBLE PRECISION to NUMERIC(19,2).
-- Rates and scores (tax rates, confidence, vsMedian) stay as DOUBLE PRECISION.

ALTER TABLE IF EXISTS payroll_records
    ALTER COLUMN base_salary TYPE NUMERIC(19,2) USING base_salary::numeric,
    ALTER COLUMN allowances TYPE NUMERIC(19,2) USING allowances::numeric,
    ALTER COLUMN deductions TYPE NUMERIC(19,2) USING deductions::numeric,
    ALTER COLUMN tax TYPE NUMERIC(19,2) USING tax::numeric,
    ALTER COLUMN net_salary TYPE NUMERIC(19,2) USING net_salary::numeric;

ALTER TABLE IF EXISTS enhanced_payroll_records
    ALTER COLUMN base_salary TYPE NUMERIC(19,2) USING base_salary::numeric,
    ALTER COLUMN allowances TYPE NUMERIC(19,2) USING allowances::numeric,
    ALTER COLUMN deductions TYPE NUMERIC(19,2) USING deductions::numeric,
    ALTER COLUMN tax TYPE NUMERIC(19,2) USING tax::numeric,
    ALTER COLUMN social_security TYPE NUMERIC(19,2) USING social_security::numeric,
    ALTER COLUMN medicare TYPE NUMERIC(19,2) USING medicare::numeric,
    ALTER COLUMN net_salary TYPE NUMERIC(19,2) USING net_salary::numeric,
    ALTER COLUMN gross_salary TYPE NUMERIC(19,2) USING gross_salary::numeric;

ALTER TABLE IF EXISTS bonuses
    ALTER COLUMN amount TYPE NUMERIC(19,2) USING amount::numeric;

ALTER TABLE IF EXISTS compensation_plans
    ALTER COLUMN current_base_salary TYPE NUMERIC(19,2) USING current_base_salary::numeric,
    ALTER COLUMN proposed_base_salary TYPE NUMERIC(19,2) USING proposed_base_salary::numeric;

ALTER TABLE IF EXISTS equity_grants
    ALTER COLUMN shares TYPE NUMERIC(19,4) USING shares::numeric,
    ALTER COLUMN strike_price TYPE NUMERIC(19,2) USING strike_price::numeric,
    ALTER COLUMN fair_market_value TYPE NUMERIC(19,2) USING fair_market_value::numeric;

ALTER TABLE IF EXISTS benefit_plans
    ALTER COLUMN employer_contribution TYPE NUMERIC(19,2) USING employer_contribution::numeric,
    ALTER COLUMN employee_contribution TYPE NUMERIC(19,2) USING employee_contribution::numeric,
    ALTER COLUMN max_benefit_amount TYPE NUMERIC(19,2) USING max_benefit_amount::numeric;

ALTER TABLE IF EXISTS benefit_enrollments
    ALTER COLUMN employee_contribution TYPE NUMERIC(19,2) USING employee_contribution::numeric,
    ALTER COLUMN employer_contribution TYPE NUMERIC(19,2) USING employer_contribution::numeric;

ALTER TABLE IF EXISTS bank_transactions
    ALTER COLUMN amount TYPE NUMERIC(19,2) USING amount::numeric;

ALTER TABLE IF EXISTS tax_brackets
    ALTER COLUMN min_income TYPE NUMERIC(19,2) USING min_income::numeric,
    ALTER COLUMN max_income TYPE NUMERIC(19,2) USING max_income::numeric,
    ALTER COLUMN flat_amount TYPE NUMERIC(19,2) USING flat_amount::numeric;

ALTER TABLE IF EXISTS payroll_forecasts
    ALTER COLUMN projected_gross_payroll TYPE NUMERIC(19,2) USING projected_gross_payroll::numeric,
    ALTER COLUMN projected_net_payroll TYPE NUMERIC(19,2) USING projected_net_payroll::numeric,
    ALTER COLUMN projected_tax TYPE NUMERIC(19,2) USING projected_tax::numeric,
    ALTER COLUMN projected_benefits TYPE NUMERIC(19,2) USING projected_benefits::numeric;

ALTER TABLE IF EXISTS expense_reports
    ALTER COLUMN amount TYPE NUMERIC(19,2) USING amount::numeric;

ALTER TABLE IF EXISTS salary_benchmarks
    ALTER COLUMN percentile10 TYPE NUMERIC(19,2) USING percentile10::numeric,
    ALTER COLUMN percentile25 TYPE NUMERIC(19,2) USING percentile25::numeric,
    ALTER COLUMN percentile50 TYPE NUMERIC(19,2) USING percentile50::numeric,
    ALTER COLUMN percentile75 TYPE NUMERIC(19,2) USING percentile75::numeric,
    ALTER COLUMN percentile90 TYPE NUMERIC(19,2) USING percentile90::numeric;

ALTER TABLE IF EXISTS country_tax_configs
    ALTER COLUMN standard_deduction TYPE NUMERIC(19,2) USING standard_deduction::numeric;
