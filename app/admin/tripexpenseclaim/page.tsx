import { randomUUID } from "node:crypto"
import type { Metadata } from "next"
import Link from "next/link"
import { hasAdminPagePermission } from "@/lib/adminAuth"
import {
  formatTripDate,
  formatTripHkd,
  isTripExpenseId,
  todayInHongKong,
  TRIP_EXPENSE_PAGE,
  TRIP_EXPENSE_PAGE_ID,
  tripClaimHref,
} from "@/lib/tripExpenseClaim"
import { TRIP_IMPORT_SECTION } from "@/lib/tripExpenseImport"
import {
  createTripExpenseDb,
  getTripClaim,
  listTripClaims,
  tripExpensePageSession,
  TRIP_CLAIMS_PAGE_SIZE,
  type TripClaimRow,
  type TripClaimSummary,
} from "@/lib/tripExpenseStore"
import { TripExpenseForm } from "./TripExpenseForm"
import { TripExpenseDetail } from "./TripExpenseDetail"
import styles from "./tripExpense.module.css"

export const metadata: Metadata = { title: "Trip Expense Claim - FC Uno" }

function ClaimList({ rows, page }: { rows: TripClaimSummary[]; page: number }) {
  const pageHref = (number: number) => number === 1 ? TRIP_EXPENSE_PAGE : TRIP_EXPENSE_PAGE + "?page=" + number
  return (
    <div className={styles.panel}>
      {rows.length === 0 ? <p className={styles.empty}>No submitted claims</p> : (
        <div className={styles.sheet}>
          <table className={styles.claimList}>
            <thead>
              <tr><th scope="col">Claim Date</th><th scope="col">Submitter</th><th scope="col">Destination</th>
                <th scope="col">Trip Dates</th><th scope="col">Claim Total (HKD)</th><th scope="col">Status</th></tr>
            </thead>
            <tbody>
              {rows.slice(0, TRIP_CLAIMS_PAGE_SIZE).map(row => (
                <tr key={row.id}>
                  <td data-label="Claim Date"><time dateTime={row.claim_date}>{formatTripDate(row.claim_date)}</time></td>
                  <td data-label="Submitter">{row.submitter_name}</td>
                  <th className={styles.destination} scope="row">
                    <Link href={tripClaimHref(row.id)} prefetch={false}>{row.country}</Link>
                  </th>
                  <td data-label="Trip Dates">{formatTripDate(row.departure_date)} – {formatTripDate(row.return_date)}</td>
                  <td className={styles.moneyCell} data-label="Claim Total (HKD)">{formatTripHkd(row.claim_cents)}</td>
                  <td data-label="Status">
                    <span className={styles.status} data-sent={Boolean(row.emailed_at)}>{tripClaimStatus(row)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(page > 1 || rows.length > TRIP_CLAIMS_PAGE_SIZE) && (
        <nav className={styles.paging} aria-label="Claim pages">
          {page > 1 && <Link className={styles.button} href={pageHref(page - 1)}>Previous</Link>}
          {rows.length > TRIP_CLAIMS_PAGE_SIZE && <Link className={styles.button} href={pageHref(page + 1)}>Next</Link>}
        </nav>
      )}
    </div>
  )
}

function tripClaimStatus(row: Pick<TripClaimSummary, "backed_up_at" | "email_attempted_at" | "emailed_at" | "delivery_lease_until">) {
  if (row.emailed_at) return "Email Sent"
  if (row.email_attempted_at && (!row.delivery_lease_until || Date.parse(row.delivery_lease_until) <= Date.now())) {
    return "Email Unconfirmed"
  }
  return row.backed_up_at ? "Email Pending" : "Backup Pending"
}

export default async function TripExpenseClaimPage({ searchParams }: {
  searchParams: Promise<{ claim?: string | string[]; page?: string | string[] }>
}) {
  const session = await tripExpensePageSession().catch(() => null)
  if (!session) return null
  const params = await searchParams
  const canEdit = hasAdminPagePermission(session, TRIP_EXPENSE_PAGE_ID, "edit")
  const selected = typeof params.claim === "string" ? params.claim : ""
  const pageNumber = typeof params.page === "string" && /^\d{1,4}$/.test(params.page) ? Math.max(1, Number(params.page)) : 1
  let loadFailed = false
  let claim: TripClaimRow | null = null
  let rows: TripClaimSummary[] = []
  try {
    if (!selected) rows = await listTripClaims(createTripExpenseDb(), session, (pageNumber - 1) * TRIP_CLAIMS_PAGE_SIZE)
    else if (isTripExpenseId(selected)) claim = await getTripClaim(createTripExpenseDb(), selected, session)
  } catch {
    loadFailed = true
  }

  let content
  if (loadFailed) {
    content = <p className={styles.panel} role="alert">Could not load claims. Refresh to try again.</p>
  } else if (selected === "new") {
    content = canEdit
      ? <TripExpenseForm id={randomUUID()} firstItemId={randomUUID()} claimDate={todayInHongKong()}
          submitter={session.displayName || session.username || "FCUNO staff"} />
      : <p className={styles.panel}>You have view-only access.</p>
  } else if (claim) {
    const status = tripClaimStatus(claim)
    content = <TripExpenseDetail claim={claim} status={status} pending={status.endsWith("Pending")} />
  } else if (selected) {
    content = <p className={styles.panel}>Claim not found.</p>
  } else {
    content = <ClaimList rows={rows} page={pageNumber} />
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        {selected ? (
          <nav className={styles.back} aria-label="Trip expense claims">
            <Link className={styles.button} href={TRIP_EXPENSE_PAGE}>← Back</Link>
          </nav>
        ) : (
          <header className={styles.header}>
            <h1>Trip Expense Claim</h1>
            {canEdit && <div className={styles.claimActions}>
              <Link className={styles.button} href={tripClaimHref("new") + "#" + TRIP_IMPORT_SECTION} prefetch={false}>Prepare from Upload</Link>
              <Link className={styles.primary} href={tripClaimHref("new")} prefetch={false}>File New Claim</Link>
            </div>}
          </header>
        )}
        {content}
      </div>
    </div>
  )
}
