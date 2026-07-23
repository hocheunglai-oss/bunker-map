const ICE_CONTRACTS_URL =
  "https://www.ice.com/marketdata/api/productguide/charting/contract-data?productId=254&hubId=403"
const ICE_INTRADAY_URL =
  "https://www.ice.com/marketdata/api/productguide/charting/data/current-day"
const ICE_PRODUCT_URL =
  "https://www.ice.com/products/219/Brent-Crude-Futures/data"
const REQUEST_TIMEOUT_MS = 6000
const MAX_QUOTE_AGE_MS = 45 * 60 * 1000
const MAX_QUOTE_CHART_DIFFERENCE = 1
const MAX_POINTS = 48

type IceContract = {
  marketId?: unknown
  marketStrip?: unknown
  lastPrice?: unknown
  lastTime?: unknown
  change?: unknown
  volume?: unknown
}

type IceIntraday = {
  marketId?: unknown
  bars?: unknown
}

export type BrentMarketData = {
  symbol: "Brent"
  instrument: "ICE Brent Crude Futures"
  contract: string
  marketId: number
  price: number
  change: number
  changePercent: number
  previousClose: number
  points: number[]
  updatedAt: string
  chartUpdatedAt: string
  source: "ICE"
  sourceName: "Intercontinental Exchange"
  sourceUrl: string
  delayedMinutes: 15
  verified: true
}

function finiteNumber(value: unknown) {
  if (value == null || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseIceTimestamp(value: unknown) {
  const match = String(value || "").match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\s+(AM|PM)\s+GMT$/i,
  )
  if (!match) return null

  const [, month, day, year, hourText, minute, period] = match
  let hour = Number(hourText) % 12
  if (period.toUpperCase() === "PM") hour += 12
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    hour,
    Number(minute),
  )
  return Number.isFinite(timestamp) ? timestamp : null
}

function parseChartTimestamp(value: unknown) {
  const text = String(value || "").trim()
  const timestamp = Date.parse(/\b(?:GMT|UTC)\b/i.test(text) ? text : `${text} GMT`)
  return Number.isFinite(timestamp) ? timestamp : null
}

function assertFreshTimestamp(timestamp: number, now: number, label: string) {
  const age = now - timestamp
  if (age < -5 * 60 * 1000) throw new Error(`${label} timestamp is in the future.`)
  if (age > MAX_QUOTE_AGE_MS) throw new Error(`${label} is stale.`)
}

function samplePoints(values: number[], limit = MAX_POINTS) {
  if (values.length <= limit) return values
  const sampled: number[] = []
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.round((index / (limit - 1)) * (values.length - 1))
    sampled.push(values[sourceIndex])
  }
  return sampled
}

export function parseIceBrentMarketData(
  contractsPayload: unknown,
  intradayPayload: unknown,
  now = Date.now(),
): BrentMarketData {
  if (!Array.isArray(contractsPayload)) throw new Error("ICE contract data is invalid.")

  const contract = (contractsPayload as IceContract[]).find((candidate) => {
    const marketId = finiteNumber(candidate?.marketId)
    const price = finiteNumber(candidate?.lastPrice)
    const quoteTimestamp = parseIceTimestamp(candidate?.lastTime)
    return (
      marketId != null &&
      price != null &&
      quoteTimestamp != null &&
      /^[A-Z][a-z]{2}\d{2}$/.test(String(candidate?.marketStrip || ""))
    )
  })
  if (!contract) throw new Error("ICE front-month Brent contract is unavailable.")

  const marketId = finiteNumber(contract.marketId)
  const price = finiteNumber(contract.lastPrice)
  const changePercent = finiteNumber(contract.change)
  const contractName = String(contract.marketStrip || "")
  const quoteTimestamp = parseIceTimestamp(contract.lastTime)
  if (
    marketId == null ||
    price == null ||
    changePercent == null ||
    quoteTimestamp == null
  ) {
    throw new Error("ICE front-month Brent quote is incomplete.")
  }
  if (price < 20 || price > 250) throw new Error("ICE Brent price failed its range check.")
  if (Math.abs(changePercent) > 30) {
    throw new Error("ICE Brent change failed its range check.")
  }
  assertFreshTimestamp(quoteTimestamp, now, "ICE Brent quote")

  const intraday = intradayPayload as IceIntraday
  if (finiteNumber(intraday?.marketId) !== marketId || !Array.isArray(intraday?.bars)) {
    throw new Error("ICE Brent chart does not match the front-month contract.")
  }

  const bars = intraday.bars
    .map((entry) => {
      if (!Array.isArray(entry)) return null
      const timestamp = parseChartTimestamp(entry[0])
      const value = finiteNumber(entry[1])
      return timestamp != null && value != null ? { timestamp, value } : null
    })
    .filter((entry): entry is { timestamp: number; value: number } => entry != null)
    .sort((first, second) => first.timestamp - second.timestamp)

  if (bars.length < 2) throw new Error("ICE Brent intraday chart is unavailable.")
  const latestBar = bars[bars.length - 1]
  assertFreshTimestamp(latestBar.timestamp, now, "ICE Brent chart")
  if (Math.abs(latestBar.value - price) > MAX_QUOTE_CHART_DIFFERENCE) {
    throw new Error("ICE Brent quote and chart failed their agreement check.")
  }

  const previousClose = price / (1 + changePercent / 100)
  const change = price - previousClose
  if (!Number.isFinite(previousClose) || previousClose <= 0 || !Number.isFinite(change)) {
    throw new Error("ICE Brent previous settlement is invalid.")
  }

  return {
    symbol: "Brent",
    instrument: "ICE Brent Crude Futures",
    contract: contractName,
    marketId,
    price,
    change,
    changePercent,
    previousClose,
    points: samplePoints(bars.map((bar) => bar.value)),
    updatedAt: new Date(quoteTimestamp).toISOString(),
    chartUpdatedAt: new Date(latestBar.timestamp).toISOString(),
    source: "ICE",
    sourceName: "Intercontinental Exchange",
    sourceUrl: `${ICE_PRODUCT_URL}?marketId=${marketId}&span=1`,
    delayedMinutes: 15,
    verified: true,
  }
}

async function fetchJson(url: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "User-Agent": "FCUNO-Brent-Monitor/1.0",
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`ICE market data returned ${response.status}.`)
    return (await response.json()) as unknown
  } finally {
    clearTimeout(timeout)
  }
}

export async function getBrentMarketData() {
  const contracts = await fetchJson(ICE_CONTRACTS_URL)
  if (!Array.isArray(contracts)) throw new Error("ICE contract data is invalid.")

  const frontContract = (contracts as IceContract[]).find((candidate) => {
    return (
      finiteNumber(candidate?.marketId) != null &&
      finiteNumber(candidate?.lastPrice) != null &&
      parseIceTimestamp(candidate?.lastTime) != null
    )
  })
  const marketId = finiteNumber(frontContract?.marketId)
  if (marketId == null) throw new Error("ICE front-month Brent contract is unavailable.")

  const intraday = await fetchJson(
    `${ICE_INTRADAY_URL}?marketId=${encodeURIComponent(String(marketId))}`,
  )
  return parseIceBrentMarketData(contracts, intraday)
}
