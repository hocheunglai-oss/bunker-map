"use client"

import { useEffect, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import {
  calculateExpenseHkd,
  EXPENSE_PAYERS,
  EXPENSE_TYPES,
  formatTripDate,
  formatTripHkd,
  isTripDate,
  MAX_CLAIM_RECEIPT_BYTES,
  MAX_CLAIM_RECEIPTS,
  MAX_EXPENSE_ITEMS,
  parseTripReceipt,
  RECEIPT_TYPES,
  summarizeTripExpense,
  TRIP_CURRENCIES,
  TRIP_EXPENSE_API,
  tripClaimHref,
  tripReceiptMime,
  validateTripExpense,
  type TripExchangeRate,
  type TripExpenseInput,
  type TripExpenseItem,
  type TripReceipt,
} from "@/lib/tripExpenseClaim"
import { ExpenseSummary } from "./ExpenseSummary"
import styles from "./tripExpense.module.css"

type LocalReceipt = TripReceipt & { file: File }
type FormItem = Omit<TripExpenseItem, "receipts"> & { receipts: LocalReceipt[] }
type ClaimDraft = Omit<TripExpenseInput, "rate" | "items"> & { items: FormItem[] }
type RateLookup = { key: string; rate: TripExchangeRate | null; message?: string }

const currencyNames = new Intl.DisplayNames("en", { type: "currency" })
const receiptAccept = Object.keys(RECEIPT_TYPES).map(extension => "." + extension).join(",")

function newItem(id: string, currency: FormItem["currency"]): FormItem {
  return { id, currency, amount: "", notes: "", category: "miscellaneous", paidBy: "own", receipts: [] }
}

async function claimRequest(path: string, body: unknown) {
  const response = await fetch(TRIP_EXPENSE_API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) throw new Error(result?.message || "Could not submit the claim. Try again.")
  return result
}

async function uploadReceipt(claimId: string, itemId: string, receipt: LocalReceipt) {
  const { file, ...metadata } = receipt
  const result = await claimRequest("/receipts", { claimId, itemId, receipt: metadata })
  if (result.submitted) return "submitted"
  if (result.uploaded) return "uploaded"

  const url = new URL(result.url)
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
      url.origin !== new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin) throw new Error("Invalid receipt upload destination.")
  const headers = new Headers({
    "Content-Type": tripReceiptMime(receipt.name) || "application/octet-stream",
    "Cache-Control": "max-age=0",
    "x-upsert": "false",
  })
  if (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) headers.set("apikey", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const upload = await fetch(url, {
    method: "PUT", headers, body: file, credentials: "omit",
    redirect: "error", signal: AbortSignal.timeout(120_000),
  })
  if (!upload.ok) throw new Error("Could not upload " + receipt.name + ". Try again.")
  return "uploaded"
}

export function TripExpenseForm({ id, firstItemId, submitter, claimDate }: {
  id: string
  firstItemId: string
  submitter: string
  claimDate: string
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<ClaimDraft>({
    id, travellers: submitter, country: "", cities: "", departureDate: "", returnDate: "",
    currency: "HKD", fundReceived: "", fundReturned: "", items: [newItem(firstItemId, "HKD")],
  })
  const [manualRate, setManualRate] = useState<string | null>(null)
  const [lookup, setLookup] = useState<RateLookup | null>(null)
  const [rateAttempt, setRateAttempt] = useState(0)
  const [notice, setNotice] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const quoteKey = draft.currency !== "HKD" && isTripDate(draft.departureDate) && draft.departureDate <= claimDate
    ? draft.currency + "/" + draft.departureDate
    : null

  useEffect(() => {
    if (!quoteKey || manualRate !== null) return
    const [currency, date] = quoteKey.split("/")
    const controller = new AbortController()
    const params = new URLSearchParams({ currency, date })
    fetch(TRIP_EXPENSE_API + "/rate?" + params, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error()
        const rate: TripExchangeRate = await response.json()
        if (!controller.signal.aborted) setLookup({ key: quoteKey, rate })
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLookup({ key: quoteKey, rate: null, message: "Automatic rate unavailable. Enter it manually." })
        }
      })
    return () => controller.abort()
  }, [quoteKey, manualRate, rateAttempt])

  const quote = quoteKey && lookup?.key === quoteKey ? lookup : null
  const rate: TripExchangeRate | null = draft.currency === "HKD" ? null : manualRate === null
    ? quote?.rate ?? null
    : { value: manualRate, source: "manual", date: null }
  const items = draft.items.map(item => ({ ...item, hkdCents: calculateExpenseHkd(item, draft.currency, rate) }))
  const totals = summarizeTripExpense(items, draft.fundReceived, draft.fundReturned)

  function updateDraft(field: Exclude<keyof ClaimDraft, "items" | "id">, value: string) {
    if (field !== "currency") {
      setDraft(current => ({ ...current, [field]: value }))
      return
    }
    setManualRate(null)
    setLookup(null)
    setDraft(current => ({
      ...current, currency: value,
      items: current.items.map(item => item.amount.trim() ? item : { ...item, currency: value }),
    }))
  }

  function updateItem(id: string, values: Partial<FormItem>) {
    setDraft(current => ({ ...current, items: current.items.map(item => item.id === id ? { ...item, ...values } : item) }))
  }

  function addReceipts(item: FormItem, files: FileList | null) {
    if (!files?.length) return
    try {
      const additions = Array.from(files, file => ({
        ...parseTripReceipt({ id: crypto.randomUUID(), name: file.name, size: file.size }),
        file,
      }))
      const receipts = [...draft.items.flatMap(row => row.receipts), ...additions]
      if (receipts.length > MAX_CLAIM_RECEIPTS || receipts.reduce((total, receipt) => total + receipt.size, 0) > MAX_CLAIM_RECEIPT_BYTES) {
        throw new Error("Each claim can contain up to 30 receipts and 50 MB.")
      }
      updateItem(item.id, { receipts: [...item.receipts, ...additions] })
      setNotice("")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not attach the receipt.")
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setNotice("")
    setSubmitting(true)
    let navigated = false
    try {
      const input = {
        ...draft,
        rate,
        items: draft.items.map(item => ({
          ...item,
          receipts: item.receipts.map(({ id, name, size }) => ({ id, name, size })),
        })),
      }
      validateTripExpense(input, claimDate)
      for (const item of draft.items) {
        for (const receipt of item.receipts) {
          if (await uploadReceipt(draft.id, item.id, receipt) === "submitted") {
            router.replace(tripClaimHref(draft.id))
            navigated = true
            return
          }
        }
      }
      await claimRequest("", input)
      router.replace(tripClaimHref(draft.id))
      navigated = true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not submit the claim. Try again.")
    } finally {
      if (!navigated) setSubmitting(false)
    }
  }

  return (
    <form className={styles.panel} aria-label="Trip expense claim" onSubmit={submit}>
      <fieldset className={styles.fieldset} disabled={submitting}>
        <div className={styles.metaGrid}>
          <div className={styles.field}><span>Claim Submitter</span><strong>{submitter}</strong></div>
          <label className={styles.field}>Traveller(s)<input required maxLength={200} value={draft.travellers} onChange={event => updateDraft("travellers", event.target.value)} /></label>
          <label className={styles.field}>Visiting Country<input required maxLength={100} value={draft.country} onChange={event => updateDraft("country", event.target.value)} /></label>
          <label className={styles.field}>Visiting Cities<input required maxLength={200} value={draft.cities} onChange={event => updateDraft("cities", event.target.value)} /></label>
          <label className={styles.field}>Departure Date<input required type="date" max={draft.returnDate || claimDate} value={draft.departureDate} onChange={event => updateDraft("departureDate", event.target.value)} /></label>
          <label className={styles.field}>Return Date<input required type="date" min={draft.departureDate} max={claimDate} value={draft.returnDate} onChange={event => updateDraft("returnDate", event.target.value)} /></label>
          <div className={styles.field}><span>Claim Date</span><strong>{formatTripDate(claimDate)}</strong></div>
          <label className={styles.field}>Trip Currency
            <select value={draft.currency} onChange={event => updateDraft("currency", event.target.value)}>
              <option value="HKD">HKD · Hong Kong Dollar</option>
              {TRIP_CURRENCIES.filter(code => code !== "HKD").map(code => (
                <option value={code} key={code}>{code} · {currencyNames.of(code)}</option>
              ))}
            </select>
          </label>
          {draft.currency !== "HKD" && (
            <div className={styles.field}>
              <label htmlFor="trip-claim-exchange-rate">Exchange Rate (1 HKD = {draft.currency})</label>
              <div className={styles.rateEntry}>
                <input id="trip-claim-exchange-rate" inputMode="decimal" maxLength={26} value={rate?.value ?? ""}
                  onChange={event => setManualRate(event.target.value)} />
                <button type="button" className={styles.button} title="Use automatic exchange rate" onClick={() => {
                  setManualRate(null)
                  setLookup(null)
                  setRateAttempt(current => current + 1)
                }}>Auto</button>
              </div>
              <span className={styles.rateStatus} aria-live="polite">
                {manualRate !== null ? "Manual" : quote?.rate?.date ? "Frankfurter · " + formatTripDate(quote.rate.date)
                  : quote?.message || (quoteKey ? "Fetching rate…" : "Select a departure date")}
              </span>
            </div>
          )}
          <label className={styles.field}>Fund Received (HKD)<input inputMode="decimal" maxLength={24} value={draft.fundReceived} onChange={event => updateDraft("fundReceived", event.target.value)} /></label>
          <label className={styles.field}>Fund Returned (HKD)<input inputMode="decimal" maxLength={24} value={draft.fundReturned} onChange={event => updateDraft("fundReturned", event.target.value)} /></label>
          <div className={styles.field}><span>Fund Used (HKD)</span><strong>{formatTripHkd(totals.fundUsedCents)}</strong></div>
        </div>

        <section className={styles.expenses} aria-labelledby="reported-expenses">
          <div className={styles.sectionHeader}>
            <h2 id="reported-expenses">Reported Expenses</h2>
            <button type="button" className={styles.button} disabled={items.length >= MAX_EXPENSE_ITEMS} onClick={() => {
              const item = newItem(crypto.randomUUID(), draft.currency)
              setDraft(current => ({ ...current, items: [...current.items, item] }))
            }}>+ Add Expense</button>
          </div>
          <div className={styles.sheet}>
            <table className={styles.expenseTable}>
              <thead>
                <tr><th scope="col">No.</th><th scope="col">Currency</th><th scope="col">Amount</th><th scope="col">Notes</th>
                  <th scope="col">Expense Type</th><th scope="col">Paid By</th><th scope="col">Receipts</th><th scope="col">HKD</th></tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={item.id}>
                    <th className={styles.rowNumber} scope="row">
                      <span>{index + 1}</span>
                      {items.length > 1 && <button type="button" className={styles.iconButton} title={"Remove expense " + (index + 1)}
                        aria-label={"Remove expense " + (index + 1)} onClick={() => {
                          setDraft(current => ({ ...current, items: current.items.filter(row => row.id !== item.id) }))
                        }}>×</button>}
                    </th>
                    <td><label className={styles.cellField}><span>Currency</span>
                      <select aria-label={"Currency for expense " + (index + 1)} value={item.currency}
                        onChange={event => updateItem(item.id, { currency: event.target.value })}>
                        <option value="HKD">HKD</option>
                        {draft.currency !== "HKD" && <option value={draft.currency}>{draft.currency}</option>}
                        {item.currency !== "HKD" && item.currency !== draft.currency &&
                          <option value={item.currency} disabled>{item.currency}</option>}
                      </select>
                    </label></td>
                    <td><label className={styles.cellField}><span>Amount</span>
                      <input className={styles.numeric} required aria-label={"Amount for expense " + (index + 1)} inputMode="decimal"
                        maxLength={24} value={item.amount} onChange={event => updateItem(item.id, { amount: event.target.value })} />
                    </label></td>
                    <td className={styles.wideCell}><label className={styles.cellField}><span>Notes</span>
                      <input required aria-label={"Notes for expense " + (index + 1)} maxLength={300} value={item.notes}
                        onChange={event => updateItem(item.id, { notes: event.target.value })} />
                    </label></td>
                    <td className={styles.selectCell}><label className={styles.cellField}><span>Expense Type</span>
                      <select aria-label={"Type for expense " + (index + 1)} value={item.category}
                        onChange={event => updateItem(item.id, { category: event.target.value as FormItem["category"] })}>
                        {Object.entries(EXPENSE_TYPES).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
                      </select>
                    </label></td>
                    <td className={styles.selectCell}><label className={styles.cellField}><span>Paid By</span>
                      <select aria-label={"Paid by for expense " + (index + 1)} value={item.paidBy}
                        onChange={event => updateItem(item.id, { paidBy: event.target.value as FormItem["paidBy"] })}>
                        {Object.entries(EXPENSE_PAYERS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
                      </select>
                    </label></td>
                    <td className={styles.receiptCell}>
                      <ul className={styles.receipts}>
                        {item.receipts.map(receipt => (
                          <li key={receipt.id}>
                            <span title={receipt.name}>{receipt.name}</span>
                            <button type="button" className={styles.iconButton} aria-label={"Remove " + receipt.name} onClick={() => {
                              updateItem(item.id, { receipts: item.receipts.filter(file => file.id !== receipt.id) })
                            }}>×</button>
                          </li>
                        ))}
                      </ul>
                      <label className={styles.fileButton}>
                        <span>+ Receipt</span>
                        <input aria-label={"Attach receipts to expense " + (index + 1)} type="file" multiple accept={receiptAccept}
                          onChange={event => {
                            addReceipts(item, event.currentTarget.files)
                            event.currentTarget.value = ""
                          }} />
                      </label>
                    </td>
                    <td className={styles.moneyCell} data-label="HKD">{item.hkdCents === null ? "—" : formatTripHkd(item.hkdCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <ExpenseSummary totals={totals} />
      </fieldset>
      <div className={styles.footer}>
        {notice && <p className={styles.error} role="alert">{notice}</p>}
        <button type="submit" className={styles.primary} disabled={submitting}>
          {submitting ? "Submitting…" : "Submit Claim"}
        </button>
      </div>
    </form>
  )
}
