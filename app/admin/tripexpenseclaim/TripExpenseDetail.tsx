import { EXPENSE_PAYERS, EXPENSE_TYPES, formatTripDate, formatTripHkd, TRIP_EXPENSE_API } from "@/lib/tripExpenseClaim"
import type { TripClaimRow } from "@/lib/tripExpenseStore"
import { ExpenseSummary } from "./ExpenseSummary"
import { RefreshPendingClaim } from "./RefreshPendingClaim"
import styles from "./tripExpense.module.css"

export function TripExpenseDetail({ claim, status, pending }: { claim: TripClaimRow; status: string; pending: boolean }) {
  const data = claim.details
  const fields = [
    ["Claim Submitter", claim.submitter_name],
    ["Traveller(s)", data.travellers],
    ["Visiting Country", data.country],
    ["Visiting Cities", data.cities],
    ["Departure Date", formatTripDate(data.departureDate)],
    ["Return Date", formatTripDate(data.returnDate)],
    ["Claim Date", formatTripDate(data.claimDate)],
    ["Trip Currency", data.currency],
    ["Fund Received (HKD)", data.fundReceived],
    ["Fund Returned (HKD)", data.fundReturned],
    ["Fund Used (HKD)", formatTripHkd(data.totals.fundUsedCents)],
  ]
  if (data.rate) {
    fields.push(
      ["Exchange Rate (1 HKD = " + data.currency + ")", data.rate.value],
      ["Rate Source", data.rate.date ? "Frankfurter · " + formatTripDate(data.rate.date) : "Manual"],
    )
  }

  return (
    <article className={styles.panel}>
      <div className={styles.detailStatus}>
        {pending && <RefreshPendingClaim />}
        <span className={styles.status} data-sent={Boolean(claim.emailed_at)}>{status}</span>
      </div>
      <dl className={styles.metaGrid}>
        {fields.map(([label, value]) => <div className={styles.field} key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      <section className={styles.expenses} aria-labelledby="reported-expenses">
        <div className={styles.sectionHeader}><h2 id="reported-expenses">Reported Expenses</h2></div>
        <div className={styles.sheet}>
          <table className={styles.expenseTable}>
            <thead>
              <tr><th scope="col">No.</th><th scope="col">Currency</th><th scope="col">Amount</th><th scope="col">Notes</th>
                <th scope="col">Expense Type</th><th scope="col">Paid By</th><th scope="col">Receipts</th><th scope="col">HKD</th></tr>
            </thead>
            <tbody>
              {data.items.map((item, index) => (
                <tr key={item.id}>
                  <th className={styles.rowNumber} scope="row"><span>{index + 1}</span></th>
                  <td data-label="Currency">{item.currency}</td>
                  <td data-label="Amount">{item.amount}</td>
                  <td className={styles.wideCell} data-label="Notes">{item.notes}</td>
                  <td data-label="Expense Type">{EXPENSE_TYPES[item.category]}</td>
                  <td data-label="Paid By">{EXPENSE_PAYERS[item.paidBy]}</td>
                  <td className={styles.receiptCell} data-label="Receipts">
                    {item.receipts.length === 0 ? "—" : (
                      <ul className={styles.receipts}>
                        {item.receipts.map(receipt => (
                          <li key={receipt.id}>
                            <a href={TRIP_EXPENSE_API + "/receipts?claim=" + claim.id + "&receipt=" + receipt.id}>{receipt.name}</a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={styles.moneyCell} data-label="HKD">{formatTripHkd(item.hkdCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ExpenseSummary totals={data.totals} />
    </article>
  )
}
