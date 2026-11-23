export const TRIP_EXPENSE_PAGE = "/admin/tripexpenseclaim"
export const TRIP_EXPENSE_API = "/api/admin/trip-expense-claims"
export const TRIP_EXPENSE_PAGE_ID = "trip-expense-claim"
export const TRIP_EXPENSE_RECEIPT_BUCKET = "trip-expense-receipts"

export const EXPENSE_TYPES = {
  home: "Travel – Home",
  international: "Travel – International",
  overseas: "Travel – Overseas",
  visa: "Visa Fee",
  airport: "Airport Tax",
  hotel: "Hotel Charges",
  businessMeals: "Restaurant & Bars – Business",
  conference: "Conference & Seminar Fee",
  gifts: "Gifts",
  staffMeals: "Restaurant & Bars – Staff",
  miscellaneous: "Miscellaneous",
} as const

export const EXPENSE_PAYERS = {
  own: "My Own Money",
  fund: "Administrator Fund",
  office: "Office Direct Payment",
} as const

export const RECEIPT_TYPES = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
} as const

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024
export const MAX_CLAIM_RECEIPT_BYTES = 50 * 1024 * 1024
export const MAX_CLAIM_RECEIPTS = 30
export const MAX_EXPENSE_ITEMS = 80

type ExpenseType = keyof typeof EXPENSE_TYPES
type ExpensePayer = keyof typeof EXPENSE_PAYERS

export type TripReceipt = { id: string; name: string; size: number }
export type TripExpenseItem = {
  id: string
  currency: string
  amount: string
  notes: string
  category: ExpenseType
  paidBy: ExpensePayer
  receipts: TripReceipt[]
}
export type TripExchangeRate = {
  value: string
  source: "frankfurter" | "manual"
  date: string | null
}
export type TripExpenseInput = {
  id: string
  travellers: string
  country: string
  cities: string
  departureDate: string
  returnDate: string
  currency: string
  rate: TripExchangeRate | null
  fundReceived: string
  fundReturned: string
  items: TripExpenseItem[]
}
export type FiledTripExpense = Omit<TripExpenseInput, "items"> & {
  claimDate: string
  items: (TripExpenseItem & { hkdCents: number })[]
  totals: ExpenseTotals
}

type ExpenseTotals = {
  totalCents: number
  claimCents: number
  fundUsedCents: number
  paidBy: Record<ExpensePayer, number>
  categories: Partial<Record<ExpenseType, number>>
}

export class TripExpenseInputError extends Error {}

export const TRIP_CURRENCIES = Intl.supportedValuesOf("currency")
const currencyCodes = new Set(TRIP_CURRENCIES)
const hkd = new Intl.NumberFormat("en-HK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const hktDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Hong_Kong", dateStyle: "short" })
const shortDate = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium" })
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const zero = BigInt(0)

export function isTripExpenseId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value)
}

export function isTripCurrency(value: unknown): value is string {
  return typeof value === "string" && currencyCodes.has(value)
}

export function isTripDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function todayInHongKong() {
  return hktDate.format(new Date())
}

export function formatTripDate(value: string) {
  return shortDate.format(new Date(value.slice(0, 10)))
}

export function formatTripHkd(cents: number) {
  return hkd.format(cents / 100)
}

export function tripClaimHref(id: string) {
  return TRIP_EXPENSE_PAGE + "?claim=" + encodeURIComponent(id)
}

export function tripReceiptMime(name: string) {
  const extension = name.split(".").at(-1)?.toLowerCase() || ""
  return Object.hasOwn(RECEIPT_TYPES, extension) ? RECEIPT_TYPES[extension as keyof typeof RECEIPT_TYPES] : null
}

function fail(message: string): never {
  throw new TripExpenseInputError(message)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("Invalid claim.")
  return value as Record<string, unknown>
}

function text(value: unknown, max: number) {
  if (typeof value !== "string") return ""
  const cleaned = value.trim()
  return cleaned.length <= max ? cleaned : ""
}

export function parseTripReceipt(value: unknown): TripReceipt {
  const raw = record(value)
  const name = text(raw.name, 180)
  if (!isTripExpenseId(raw.id) || !tripReceiptMime(name) || /[/\\\r\n]/.test(name) || !name.includes(".")) {
    fail("Use a PDF, JPG, PNG, WebP or HEIC receipt.")
  }
  if (typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 1 || raw.size > MAX_RECEIPT_BYTES) {
    fail("Each receipt must be 10 MB or smaller.")
  }
  return { id: raw.id, name, size: raw.size }
}

function decimal(value: unknown, places: number) {
  if (typeof value !== "string" || value.length > 32) return null
  const normalized = value.trim()
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d+)?$/.test(normalized) || !normalized) return null
  const [whole, fraction = ""] = normalized.replaceAll(",", "").split(".")
  if (whole.length > 12 || fraction.length > places) return null
  return BigInt((whole || "0") + fraction.padEnd(places, "0"))
}

export function parseTripRate(value: unknown) {
  const rate = decimal(value, 12)
  return rate !== null && rate > zero ? rate : null
}

export function calculateExpenseHkd(
  item: Pick<TripExpenseItem, "currency" | "amount">,
  tripCurrency: string,
  rate: TripExchangeRate | null,
) {
  const isForeign = item.currency !== "HKD"
  if (isForeign && item.currency !== tripCurrency) return null
  const amount = decimal(item.amount, isForeign ? 4 : 2)
  if (amount === null || amount <= zero) return null
  const divisor = isForeign ? parseTripRate(rate?.value) : BigInt(1)
  if (!divisor) return null
  const numerator = isForeign ? amount * BigInt(10_000_000_000) : amount
  const cents = Number((numerator + divisor / BigInt(2)) / divisor)
  return cents <= 100_000_000_000_000 ? cents : null
}

export function summarizeTripExpense(
  items: (TripExpenseItem & { hkdCents: number | null })[],
  fundReceived: string,
  fundReturned: string,
): ExpenseTotals {
  const paidBy = { own: 0, fund: 0, office: 0 }
  const categories: ExpenseTotals["categories"] = {}
  for (const item of items) {
    if (item.hkdCents === null) continue
    paidBy[item.paidBy] += item.hkdCents
    categories[item.category] = (categories[item.category] ?? 0) + item.hkdCents
  }
  const claimCents = paidBy.own + paidBy.fund
  const fundUsedCents = Number((decimal(fundReceived, 2) ?? zero) - (decimal(fundReturned, 2) ?? zero))
  return { paidBy, categories, totalCents: claimCents + paidBy.office, claimCents, fundUsedCents }
}

export function validateTripExpense(value: unknown, claimDate = todayInHongKong()): FiledTripExpense {
  const raw = record(value)
  if (!isTripExpenseId(raw.id)) fail("Invalid claim.")
  const travellers = text(raw.travellers, 200)
  const country = text(raw.country, 100)
  const cities = text(raw.cities, 200)
  if (!travellers || !country || !cities) fail("Enter the travellers, country and cities.")
  if (!isTripDate(raw.departureDate) || !isTripDate(raw.returnDate)) fail("Enter the departure and return dates.")
  if (raw.departureDate > raw.returnDate || raw.returnDate > claimDate) fail("Check the departure and return dates.")
  const tripCurrency = raw.currency
  if (!isTripCurrency(tripCurrency)) fail("Select a trip currency.")

  const rate = raw.rate == null ? null : record(raw.rate)
  let exchangeRate: TripExchangeRate | null = null
  if (rate && tripCurrency !== "HKD") {
    const value = text(rate.value, 32)
    if (!parseTripRate(value)) fail("Enter a valid exchange rate.")
    if (rate.source === "manual") {
      exchangeRate = { source: "manual", value, date: null }
    } else {
      if (rate.source !== "frankfurter" || !isTripDate(rate.date) || rate.date > raw.departureDate) fail("Refresh the exchange rate.")
      exchangeRate = { source: "frankfurter", value, date: rate.date }
    }
  }

  if (typeof raw.fundReceived !== "string" || typeof raw.fundReturned !== "string") fail("Check the administrator funds received and returned.")
  const fundReceived = raw.fundReceived.trim() || "0"
  const fundReturned = raw.fundReturned.trim() || "0"
  const received = decimal(fundReceived, 2)
  const returned = decimal(fundReturned, 2)
  if (received === null || returned === null || returned > received) fail("Check the administrator funds received and returned.")
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > MAX_EXPENSE_ITEMS) {
    fail("Enter between 1 and 80 expenses.")
  }

  const itemIds = new Set<string>()
  const receiptIds = new Set<string>()
  let receiptBytes = 0
  const items = raw.items.map((value, index) => {
    const item = record(value)
    const row = index + 1
    if (!isTripExpenseId(item.id) || itemIds.has(item.id)) fail("Invalid expense row.")
    itemIds.add(item.id)
    const notes = text(item.notes, 300)
    const amount = text(item.amount, 24)
    const currency = item.currency
    if (!notes || !isTripCurrency(currency)) fail("Check expense " + row + ".")
    if (currency !== "HKD" && currency !== tripCurrency) fail("Check the currency on expense " + row + ".")
    if (typeof item.category !== "string" || !Object.hasOwn(EXPENSE_TYPES, item.category) ||
        typeof item.paidBy !== "string" || !Object.hasOwn(EXPENSE_PAYERS, item.paidBy)) fail("Check expense " + row + ".")
    const hkdCents = calculateExpenseHkd({ currency, amount }, tripCurrency, exchangeRate)
    if (hkdCents === null) {
      fail(currency !== "HKD" && !exchangeRate ? "Enter an exchange rate." : "Check the amount on expense " + row + ".")
    }
    if (!Array.isArray(item.receipts) || item.receipts.length > MAX_CLAIM_RECEIPTS) fail("Invalid receipts on expense " + row + ".")
    const receipts = item.receipts.map(value => {
      const receipt = parseTripReceipt(value)
      if (receiptIds.has(receipt.id)) fail("A receipt can only be attached to one expense.")
      receiptIds.add(receipt.id)
      receiptBytes += receipt.size
      return receipt
    })
    return {
      id: item.id,
      currency,
      notes,
      amount,
      category: item.category as ExpenseType,
      paidBy: item.paidBy as ExpensePayer,
      hkdCents,
      receipts,
    } satisfies TripExpenseItem & { hkdCents: number }
  })
  if (receiptIds.size > MAX_CLAIM_RECEIPTS || receiptBytes > MAX_CLAIM_RECEIPT_BYTES) {
    fail("Each claim can contain up to 30 receipts and 50 MB.")
  }

  return {
    id: raw.id,
    travellers,
    country,
    cities,
    departureDate: raw.departureDate,
    returnDate: raw.returnDate,
    claimDate,
    currency: tripCurrency,
    rate: exchangeRate,
    fundReceived,
    fundReturned,
    items,
    totals: summarizeTripExpense(items, fundReceived, fundReturned),
  }
}
