package com.ems.payroll.repository;

import com.ems.payroll.model.BankTransaction;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.Optional;

@Repository
public interface BankTransactionRepository extends JpaRepository<BankTransaction, Long> {
    List<BankTransaction> findByTenantId(String tenantId);
    List<BankTransaction> findByTenantIdAndEmployeeId(String tenantId, String employeeId);
    List<BankTransaction> findByTenantIdAndStatus(String tenantId, String status);

    Optional<BankTransaction> findByIdAndTenantId(Long id, String tenantId);

    Optional<BankTransaction> findByTenantIdAndReference(String tenantId, String reference);

    /**
     * Tenant-scoped lookup that also takes a row lock for the lifetime of the
     * transaction, so two concurrent settles of the same transfer are
     * serialized and the status guard sees the committed state.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT t FROM BankTransaction t WHERE t.id = ?1 AND t.tenantId = ?2")
    Optional<BankTransaction> findByIdAndTenantIdForUpdate(Long id, String tenantId);

    /**
     * Payroll direct deposits whose linked payroll record belongs to the given
     * period. bank_transactions has no period column, so the period filter is
     * applied through the payroll_id link instead of comparing one period's
     * payroll against ledger rows from every period.
     */
    @Query("SELECT t FROM BankTransaction t WHERE t.tenantId = ?1 AND t.transactionType = ?2 "
            + "AND t.payrollId IN (SELECT p.id FROM EnhancedPayrollRecord p WHERE p.tenantId = ?1 AND p.period = ?3)")
    List<BankTransaction> findPayrollDepositsByTenantIdAndTypeAndPeriod(String tenantId, String transactionType,
                                                                       String period);
}
