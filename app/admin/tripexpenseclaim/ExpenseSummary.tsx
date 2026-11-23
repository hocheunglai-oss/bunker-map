import { EXPENSE_PAYERS, EXPENSE_TYPES, formatTripHkd, type FiledTripExpense } from "@/lib/tripExpenseClaim"
import styles from "./tripExpense.module.css"

export function ExpenseSummary({ totals }: { totals: FiledTripExpense["totals"] }) {
  return (
    <section className={styles.summary} aria-labelledby="expense-summary">
      <h2 id="expense-summary">Expense Summary</h2>
      <div className={styles.summaryGrid}>
        <table className={styles.smallTable}>
          <thead><tr><th scope="col">Paid By</th><th scope="col">HKD</th></tr></thead>
          <tbody>
            {(Object.keys(EXPENSE_PAYERS) as (keyof typeof EXPENSE_PAYERS)[]).map(payer => (
              <tr key={payer}><th scope="row">{EXPENSE_PAYERS[payer]}</th><td>{formatTripHkd(totals.paidBy[payer])}</td></tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th scope="row">Claim Total</th><td>{formatTripHkd(totals.claimCents)}</td></tr>
            <tr><th scope="row">Total Expenses</th><td>{formatTripHkd(totals.totalCents)}</td></tr>
          </tfoot>
        </table>
        <table className={styles.smallTable}>
          <thead><tr><th scope="col">Expense Type</th><th scope="col">HKD</th></tr></thead>
          <tbody>
            {(Object.keys(EXPENSE_TYPES) as (keyof typeof EXPENSE_TYPES)[]).filter(category => category in totals.categories).map(category => (
              <tr key={category}><th scope="row">{EXPENSE_TYPES[category]}</th><td>{formatTripHkd(totals.categories[category] ?? 0)}</td></tr>
            ))}
            {Object.keys(totals.categories).length === 0 && <tr><td colSpan={2} className={styles.muted}>No expenses</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}
