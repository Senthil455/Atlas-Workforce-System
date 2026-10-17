-- Bank transfers settle at most once and a retried create maps to the same
-- transfer. PayrollEnterpriseService builds a deterministic reference
-- ("PAY-<payrollId>-<employeeId>") and guards the status transition; this
-- unique index is the database-level backstop for both.
--
-- Existing rows created with the old time-based reference cannot collide
-- (millisecond stamps differ), so no de-duplication is needed here.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_transactions_tenant_reference
    ON bank_transactions (tenant_id, reference);
