import {
  EXPENSE_TYPES,
  isTripCurrency,
  isTripDate,
  MAX_EXPENSE_ITEMS,
  parseTripRate,
  tripReceiptMime,
  type TripExpenseInput,
  type TripExpenseItem,
} from "@/lib/tripExpenseClaim"

export const TRIP_IMPORT_SECTION = "prepare-from-upload"
export const TRIP_IMPORT_MODEL = "gpt-5.4-mini"
export const MAX_TRIP_DOCUMENT_BYTES = 4 * 1024 * 1024
export const MAX_TRIP_DOCUMENT_REQUEST_BYTES = MAX_TRIP_DOCUMENT_BYTES + 32 * 1024

export const TRIP_DOCUMENT_KINDS = ["receipt", "priceLabel", "itinerary", "claimForm", "multiple", "other"] as const
export type TripImportRow = Omit<TripExpenseItem, "id" | "receipts"> & { sourceIds: string[] }
type TripImportHeader = Omit<TripExpenseInput, "id" | "items" | "rate"> & { rate: string | null }
export type TripImportWorkbook = TripImportHeader & { items: Omit<TripImportRow, "sourceIds">[] }
export type TripImportDocument = {
  kind: (typeof TRIP_DOCUMENT_KINDS)[number]
  merchant: string
  date: string
  amount: string
  currency: string
  chargedAmount: string
  chargedCurrency: string
  reference: string
  category: TripExpenseItem["category"]
  travellers: string
  country: string
  cities: string
  departureDate: string
  returnDate: string
}
export type TripImportResult =
  | { type: "workbook"; value: TripImportWorkbook }
  | { type: "document"; value: TripImportDocument }
export type TripImportSource = { id: string; name: string; result?: TripImportResult; issue?: string; canAttach?: boolean }
export type PreparedTripClaim = TripImportHeader & { items: TripImportRow[]; issues: string[] }

export function tripImportKind(name: string) {
  if (/\.xlsx$/i.test(name)) return "workbook"
  const mime = tripReceiptMime(name)
  if (mime === "application/pdf") return "pdf"
  if (mime?.startsWith("image/")) return "image"
  return null
}

function normalized(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

function stem(name: string) {
  return normalized(name.replace(/\.[^.]+$/, ""))
}

export function tripImportAlreadyClaimed(name: string) {
  const words = stem(name)
  return /\bclaimed\b/.test(words) && !/\b(?:not|never) claimed\b/.test(words)
}

export function tripImportClaimFormName(name: string) {
  return /^trip expense (?:report and )?claim form\b/.test(stem(name))
}

export function tripImportMoney(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return ""
  const raw = String(value).trim()
  if (!/^(?:\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:\.\d{1,4})?$/.test(raw)) return ""
  const [whole, fraction] = raw.replaceAll(",", "").split(".")
  return !fraction ? whole : whole + "." + fraction
}

export function tripImportText(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim().slice(0, max) : ""
}

export function parseTripImportDocument(value: unknown): TripImportDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (!TRIP_DOCUMENT_KINDS.includes(data.kind as TripImportDocument["kind"])) return null
  const amount = tripImportMoney(data.amount)
  const chargedAmount = tripImportMoney(data.chargedAmount)
  return {
    kind: data.kind as TripImportDocument["kind"],
    merchant: tripImportText(data.merchant, 120),
    date: isTripDate(data.date) ? data.date : "",
    amount: amount && Number(amount) > 0 ? amount : "",
    currency: isTripCurrency(data.currency) ? data.currency : "",
    chargedAmount: chargedAmount && Number(chargedAmount) > 0 ? chargedAmount : "",
    chargedCurrency: isTripCurrency(data.chargedCurrency) ? data.chargedCurrency : "",
    reference: tripImportText(data.reference, 100),
    category: typeof data.category === "string" && Object.hasOwn(EXPENSE_TYPES, data.category)
      ? data.category as TripImportDocument["category"] : "miscellaneous",
    travellers: tripImportText(data.travellers, 200),
    country: tripImportText(data.country, 100),
    cities: tripImportText(data.cities, 200),
    departureDate: isTripDate(data.departureDate) ? data.departureDate : "",
    returnDate: isTripDate(data.returnDate) ? data.returnDate : "",
  }
}

function charge(document: TripImportDocument) {
  if (document.chargedAmount && document.chargedCurrency === "HKD") {
    return { amount: document.chargedAmount, currency: document.chargedCurrency }
  }
  return { amount: document.amount, currency: document.currency }
}

function matchWorkbookRow(rows: TripImportRow[], name: string, document?: TripImportDocument) {
  const filename = stem(name)
  const direct = rows.filter(row => normalized(row.notes) === filename)
  if (direct.length !== 0 || !document) return direct.length === 1 ? direct[0] : null
  const merchant = normalized(document.merchant)
  if (merchant.length < 4) return null
  const recorded = charge(document)
  const matches = rows.filter(row => {
    const notes = normalized(row.notes)
    return (notes === merchant || notes.startsWith(merchant + " ")) &&
      recorded.currency === row.currency && Number(recorded.amount) === Number(row.amount)
  })
  return matches.length === 1 ? matches[0] : null
}

function duplicateEvidenceKey(source: TripImportSource, document: TripImportDocument) {
  const amount = charge(document)
  if (document.reference && document.merchant && amount.amount && amount.currency) {
    return JSON.stringify(["reference", normalized(document.merchant), normalized(document.reference), amount.currency, Number(amount.amount)])
  }
  if (document.kind === "priceLabel" && document.amount) {
    return JSON.stringify(["label", stem(source.name), normalized(document.merchant), Number(document.amount)])
  }
  return ""
}

export function prepareTripClaim(sources: TripImportSource[]): PreparedTripClaim {
  const workbooks = sources.flatMap(source => source.result?.type === "workbook" ? [source.result.value] : [])
  const workbook = workbooks[0]
  const docs = sources.flatMap(source =>
    source.result?.type === "document" && !tripImportAlreadyClaimed(source.name) ? [source.result.value] : [],
  )
  const trip = docs.find(doc => doc.kind === "claimForm") ?? docs.find(doc => doc.kind === "itinerary")
  const trustedCurrencies = docs.filter(doc => doc.kind === "receipt").map(doc => charge(doc).currency)
  const currency = workbook?.currency || trustedCurrencies.find(code => code && code !== "HKD") || "HKD"
  const departureDate = workbook?.departureDate || trip?.departureDate || ""
  const issues = new Set<string>()
  const rows: TripImportRow[] = (workbook?.items ?? []).slice(0, MAX_EXPENSE_ITEMS).map(item => ({ ...item, sourceIds: [] }))
  const workbookRows = [...rows]
  const duplicates = new Map<string, TripImportRow>()
  let hasSuggestedPayer = false
  if (workbooks.length > 1) issues.add("Used the first claim workbook. Check the additional workbook before submitting.")

  for (const source of sources) {
    if (tripImportAlreadyClaimed(source.name)) {
      issues.add(source.name + " was marked Claimed. Review it separately.")
      continue
    }
    if (source.issue) {
      if (source.canAttach && !tripImportClaimFormName(source.name)) {
        matchWorkbookRow(workbookRows, source.name)?.sourceIds.push(source.id)
      }
      issues.add(source.name + " — " + source.issue)
      continue
    }
    if (source.result?.type !== "document") continue
    const document = source.result.value
    if (document.kind === "claimForm" || (document.kind === "itinerary" && !document.amount && !document.chargedAmount)) continue
    if (document.kind === "multiple" || document.kind === "other") {
      issues.add(source.name + " — review and add each expense manually.")
      continue
    }

    const payment = charge(document)
    const key = duplicateEvidenceKey(source, document)
    const matched = workbook ? matchWorkbookRow(workbookRows, source.name, document) : null
    const duplicate = key ? duplicates.get(key) : undefined
    if (matched || duplicate) {
      const row = matched ?? duplicate!
      row.sourceIds.push(source.id)
      if (key) duplicates.set(key, row)
      if (matched && payment.amount && payment.currency === row.currency && Number(payment.amount) !== Number(row.amount)) {
        issues.add(source.name + " — receipt " + payment.currency + " " + payment.amount + ", workbook " + row.currency + " " + row.amount + ".")
      } else if (matched && (!payment.amount || !payment.currency || payment.currency !== row.currency)) {
        const printed = [payment.currency, payment.amount].filter(Boolean).join(" ")
        issues.add(source.name + " — confirm the workbook amount" + (printed ? " against " + printed : "") + ".")
      }
    } else if (rows.length < MAX_EXPENSE_ITEMS) {
      const useAmount = document.kind !== "priceLabel" && payment.currency && (!workbook || !workbookRows.length)
      const label = document.merchant || source.name.replace(/\.[^.]+$/, "")
      rows.push({
        notes: (document.date ? label + " · " + document.date : label).slice(0, 300),
        category: document.category,
        paidBy: "own",
        currency: payment.currency || currency,
        amount: useAmount ? payment.amount : "",
        sourceIds: [source.id],
      })
      if (key) duplicates.set(key, rows[rows.length - 1])
      hasSuggestedPayer = true
      if (workbook && workbookRows.length) issues.add(source.name + " — match this receipt to a workbook row or enter the amount separately.")
      if (!payment.currency || !payment.amount) issues.add(source.name + " — confirm the amount and currency.")
      else if (payment.currency !== "HKD" && payment.currency !== currency) issues.add(source.name + " — enter the HKD charge or use " + payment.currency + " as the trip currency.")
    } else {
      issues.add(source.name + " — the claim has reached its expense limit.")
    }

    if (document.kind === "priceLabel") issues.add(source.name + " — confirm what was paid from the price label.")
    if (departureDate && document.date && document.date < departureDate) issues.add(source.name + " — dated before departure.")
  }

  if (hasSuggestedPayer) issues.add("Confirm who paid each expense.")
  if (workbookRows.some(row => !row.sourceIds.length)) issues.add("Review workbook rows without a matched receipt.")
  return {
    travellers: workbook?.travellers || trip?.travellers || "",
    country: workbook?.country || trip?.country || "",
    cities: workbook?.cities || trip?.cities || "",
    departureDate,
    returnDate: workbook?.returnDate || trip?.returnDate || "",
    currency,
    rate: workbook?.rate && parseTripRate(workbook.rate) ? workbook.rate : null,
    fundReceived: workbook?.fundReceived || "",
    fundReturned: workbook?.fundReturned || "",
    items: rows,
    issues: [...issues],
  }
}
