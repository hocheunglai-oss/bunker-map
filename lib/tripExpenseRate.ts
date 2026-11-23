import "server-only"

import {
  isTripCurrency,
  isTripDate,
  parseTripRate,
  todayInHongKong,
  TripExpenseInputError,
  type TripExchangeRate,
} from "@/lib/tripExpenseClaim"
import { TripExpenseRequestError } from "@/lib/tripExpenseStore"

export async function readTripExchangeRate(currency: unknown, date: unknown, fetchRate = fetch): Promise<TripExchangeRate> {
  if (!isTripCurrency(currency) || currency === "HKD" || !isTripDate(date) || date > todayInHongKong()) {
    throw new TripExpenseInputError("Select a currency and departure date.")
  }
  try {
    const url = new URL("https://api.frankfurter.dev/v2/rate/HKD/" + currency)
    url.searchParams.set("date", date)
    const response = await fetchRate(url, { next: { revalidate: 3600 }, signal: AbortSignal.timeout(6000), redirect: "error" })
    if (!response.ok) throw new Error("Rate unavailable")
    const quote = await response.json()
    if (quote?.base !== "HKD" || quote.quote !== currency || !isTripDate(quote.date) || quote.date > date ||
        typeof quote.rate !== "number" || !Number.isFinite(quote.rate)) throw new Error("Invalid rate")
    const rate = quote.rate.toFixed(12).replace(/0+$/, "").replace(/\.$/, "")
    if (!parseTripRate(rate)) throw new Error("Invalid rate")
    return { source: "frankfurter", value: rate, date: quote.date }
  } catch {
    throw new TripExpenseRequestError("Automatic rate unavailable. Enter it manually.", 503)
  }
}
