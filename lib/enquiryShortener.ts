export type VlsfoMaxRemark = "180cst max" | "120cst max"

type ProductSegment = {
  product: "hsfo" | "vlsfo" | "lsmgo"
  quantity: string
  detectedRemarks: VlsfoMaxRemark[]
}

const MONTHS: Record<string, string> = {
  "1": "jan",
  "01": "jan",
  "2": "feb",
  "02": "feb",
  "3": "mar",
  "03": "mar",
  "4": "apr",
  "04": "apr",
  "5": "may",
  "05": "may",
  "6": "jun",
  "06": "jun",
  "7": "jul",
  "07": "jul",
  "8": "aug",
  "08": "aug",
  "9": "sep",
  "09": "sep",
  "10": "oct",
  "11": "nov",
  "12": "dec",
  jan: "jan",
  january: "jan",
  feb: "feb",
  february: "feb",
  mar: "mar",
  march: "mar",
  apr: "apr",
  april: "apr",
  may: "may",
  jun: "jun",
  june: "jun",
  jul: "jul",
  july: "jul",
  aug: "aug",
  august: "aug",
  sep: "sep",
  sept: "sep",
  september: "sep",
  oct: "oct",
  october: "oct",
  nov: "nov",
  november: "nov",
  dec: "dec",
  december: "dec",
}

function normalizeInput(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(/\u00ad/g, "")
    .replace(/[\u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, " ")
}

function cleanSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function normalizeQuantityNumber(value: string) {
  const normalized = value.replace(/,/g, "")
  if (/^\d+\.0+$/.test(normalized)) return normalized.split(".")[0]
  return normalized
}

function numericValue(value: string) {
  const normalized = value.replace(",", ".")
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function isUsableQuantityNumber(value: string) {
  const parsed = numericValue(value)
  return parsed !== null && parsed >= 1
}

function normalizeDate(day: string, month: string) {
  const normalizedMonth = MONTHS[month.toLowerCase()]
  if (!normalizedMonth) return ""
  return `${Number(day)} ${normalizedMonth}`
}

function findDates(value: string) {
  const normalized = normalizeInput(value)
  const dates: string[] = []

  for (const match of normalized.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*-\s*(\d{1,2})(?:st|nd|rd|th)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi)) {
    const firstDate = normalizeDate(match[1], match[3])
    const secondDate = normalizeDate(match[2], match[3])
    if (firstDate && secondDate) dates.push(`${firstDate} - ${secondDate}`)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})[./-](\d{1,2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:[./-]\d{2,4})?\b/gi)) {
    const firstDate = normalizeDate(match[1], match[3])
    const secondDate = normalizeDate(match[2], match[3])
    if (firstDate && secondDate) dates.push(`${firstDate} - ${secondDate}`)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-]\d{2,4})?\b/g)) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*[- ]\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi)) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  return Array.from(new Set(dates))
}

function extractDeliveryDate(text: string) {
  const lines = normalizeInput(text)
    .split("\n")
    .map(cleanSpaces)
    .filter(Boolean)

  const labelledLines = lines.filter((line) =>
    /^\s*(?:delivery|window|date|eta|etb|etd|ets)\b/i.test(line),
  )
  const dates = findDates(labelledLines.join(" ") || lines.join(" "))

  return dates[0] || ""
}

function classifyProduct(value: string): ProductSegment["product"] | "" {
  if (/\b(?:lsmgo|mgo|mdo|dma|dmb)\b/i.test(value)) return "lsmgo"
  if (/\b(?:hsfo|hfo|ifo|3\s*[,.]\s*5)\b/i.test(value)) return "hsfo"
  if (/\b(?:vlsfo|lsfo|0\s*[,.]\s*5|0\s*[,.]\s*50|rmg\s*180|rmg\s*380)\b/i.test(value)) {
    return "vlsfo"
  }
  return ""
}

function containsProduct(value: string) {
  return Boolean(classifyProduct(value))
}

function isLabelLine(value: string) {
  return /^[A-Za-z][A-Za-z0-9\s/&().,-]{0,48}:/.test(value)
}

function extractDetectedVlsfoRemarks(value: string): VlsfoMaxRemark[] {
  const remarks: VlsfoMaxRemark[] = []
  if (/(^|\D)180(?!\d)/.test(value)) remarks.push("180cst max")
  if (/(^|\D)120(?!\d)/.test(value)) remarks.push("120cst max")
  return remarks
}

function extractQuantityFromInlineUnit(value: string) {
  const range = value.match(/\b(\d+(?:[,.]\d{3})?|\d+)\s*(?:-|to)\s*(\d+(?:[,.]\d{3})?|\d+)\s*(?:m\s*t|mt|mts|tons?)\b/i)
  if (range) {
    return `${normalizeQuantityNumber(range[1])}-${normalizeQuantityNumber(range[2])}mts`
  }

  const matches = Array.from(value.matchAll(/\b(\d+(?:[,.]\d+)?)\s*(?:m\s*t|mt|mts|tons?)\b/gi))
    .map((match) => match[1])
    .filter(isUsableQuantityNumber)

  const quantity = matches.at(-1)
  return quantity ? `${normalizeQuantityNumber(quantity)}mts` : ""
}

function extractQuantityFromBlock(lines: string[]) {
  const inlineQuantity = extractQuantityFromInlineUnit(lines.join(" "))
  if (inlineQuantity) return inlineQuantity

  const unitIndex = lines.findIndex((line) => /^(?:m\s*t|mt|mts|tons?)$/i.test(line))
  const scanLines = unitIndex >= 0 ? lines.slice(1, unitIndex) : lines.slice(1)
  const numericLine = scanLines
    .map((line) => line.match(/^\d+(?:[,.]\d+)?$/)?.[0] || "")
    .find((value) => value && isUsableQuantityNumber(value))

  return numericLine ? `${normalizeQuantityNumber(numericLine)}mts` : ""
}

function extractProducts(text: string) {
  const lines = normalizeInput(text)
    .split("\n")
    .map(cleanSpaces)
    .filter(Boolean)

  const products: ProductSegment[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const product = classifyProduct(line)
    if (!product) continue

    const block = [line]
    let endIndex = index

    for (let offset = index + 1; offset < Math.min(lines.length, index + 6); offset += 1) {
      const nextLine = lines[offset]
      if (containsProduct(nextLine)) break
      if (isLabelLine(nextLine) && !/^(?:product|qty|quantity)\b/i.test(nextLine)) break

      block.push(nextLine)
      endIndex = offset

      if (/^(?:m\s*t|mt|mts|tons?)$/i.test(nextLine) || /\b(?:m\s*t|mt|mts|tons?)\b/i.test(nextLine)) break
    }

    const quantity = extractQuantityFromBlock(block)
    if (quantity) {
      products.push({
        product,
        quantity,
        detectedRemarks: product === "vlsfo" ? extractDetectedVlsfoRemarks(block.join(" ")) : [],
      })
    }

    index = endIndex
  }

  return products
}

function mergeRemarks(...remarkGroups: VlsfoMaxRemark[][]) {
  return Array.from(new Set(remarkGroups.flat()))
}

function formatProductSegment(segment: ProductSegment, manualVlsfoRemarks: VlsfoMaxRemark[]) {
  if (segment.product !== "vlsfo") return `${segment.product} ${segment.quantity}`

  const remarks = mergeRemarks(segment.detectedRemarks, manualVlsfoRemarks)
  return [segment.product, ...remarks, segment.quantity].join(" ")
}

export function buildShortenedEnquiry(
  sourceText: string,
  vesselName: string,
  imo: string,
  manualVlsfoRemarks: VlsfoMaxRemark[] = [],
) {
  const date = extractDeliveryDate(sourceText)
  const products = extractProducts(sourceText)
    .map((product) => formatProductSegment(product, manualVlsfoRemarks))

  return [vesselName.toLowerCase(), imo, date, ...products]
    .filter(Boolean)
    .join(" / ")
}
