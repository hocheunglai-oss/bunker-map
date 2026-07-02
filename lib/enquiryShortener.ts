import { extractEnquiryPort } from "@/lib/enquiryWorksheetParser"

export type VlsfoMaxRemark = "180cst max" | "120cst max"

export type BuildShortenedEnquiryOptions = {
  autoDetectVlsfoRemarks?: boolean
  includePort?: boolean
  port?: string
  portNames?: string[]
}

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
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[：]/g, ":")
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
  if (/^\d+$/.test(normalized) && Number(normalized) >= 1000) {
    return Number(normalized).toLocaleString("en-US")
  }
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
  const normalizedDay = Number(day)
  if (!normalizedMonth || normalizedDay < 1 || normalizedDay > 31) return ""
  if (/^\d+$/.test(month) && (Number(month) < 1 || Number(month) > 12)) return ""
  return `${normalizedDay} ${normalizedMonth}`
}

function validDateParts(day: string, month: string) {
  const normalizedMonth = MONTHS[month.toLowerCase()]
  const normalizedDay = Number(day)
  if (!normalizedMonth) return ""
  if (normalizedDay < 1 || normalizedDay > 31) return ""
  if (/^\d+$/.test(month) && (Number(month) < 1 || Number(month) > 12)) return ""
  return normalizedMonth
}

function formatDateRange(firstDay: string, firstMonth: string, secondDay: string, secondMonth: string) {
  const normalizedFirstMonth = validDateParts(firstDay, firstMonth)
  const normalizedSecondMonth = validDateParts(secondDay, secondMonth)
  if (!normalizedFirstMonth || !normalizedSecondMonth) return ""

  const first = Number(firstDay)
  const second = Number(secondDay)
  if (normalizedFirstMonth === normalizedSecondMonth) {
    return `${first} - ${second} ${normalizedFirstMonth}`
  }

  return `${first} ${normalizedFirstMonth} - ${second} ${normalizedSecondMonth}`
}

function findDates(value: string) {
  const normalized = normalizeInput(value).replace(/\[[^\]]*\d{1,2}:\d{2}[^\]]*\]/g, " ")
  const dates: string[] = []
  const monthNamePattern = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNamePattern})\\s*(?:,?\\s*\\d{2,4})?(?:\\s*\\([^)]*\\))?\\s*(?:-|~|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNamePattern})\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[2], match[3], match[4])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})[./](\d{1,2})\s*(?:-|~|\/|to)\s*(?:(\d{1,2})[./])?(\d{1,2})\b/gi)) {
    const rangeMonth = match[3] || match[1]
    const range = formatDateRange(match[2], match[1], match[4], rangeMonth)
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|~|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNamePattern})\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[3], match[2], match[3])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})\\s*\\/\\s*(\\d{1,2})[./-](\\d{1,2}|${monthNamePattern})(?:[./-]\\d{2,4})?\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[3], match[2], match[3])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(${monthNamePattern})\\s*[./-]\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*['’]?\\d{2,4})?\\b`, "gi"))) {
    const date = normalizeDate(match[2], match[1])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-]\d{2,4})?\b/g)) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+|\s*[- ]\s*)(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi)) {
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
  const compact = value.toLowerCase().replace(/\s+/g, "")
  if (/(?:lsmgo|lemgo|mgo|mdo|dma|dmb)/i.test(compact)) return "lsmgo"
  if (/(?:hsfo|hfo|ifo|3[,.]?5)/i.test(compact)) return "hsfo"
  if (/(?:vlsfo|lsfo|0[,.]?5|0[,.]?50|rmg180|rmg380|180cst|120cst)/i.test(compact)) {
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

export function detectVlsfoMaxRemarks(value: string): VlsfoMaxRemark[] {
  const normalized = normalizeInput(value)
  const remarks: VlsfoMaxRemark[] = []
  if (/(?:rmg\s*)?180\s*cst\b/i.test(normalized) || /\brmg\s*180\b/i.test(normalized)) {
    remarks.push("180cst max")
  }
  if (/(?:rmg\s*)?120\s*cst\b/i.test(normalized) || /\brmg\s*120\b/i.test(normalized)) {
    remarks.push("120cst max")
  }
  return remarks
}

export function hasVlsfoMaxCaution(value: string) {
  return /(^|\D)(?:180|120)(?!\d)/.test(value)
}

function extractQuantityFromInlineUnit(value: string) {
  const range = value.match(/\b(\d+(?:[,.]\d+)?)\s*(?:-|~|to)\s*(\d+(?:[,.]\d+)?)\s*(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?)\b/i)
  if (range) {
    return `${normalizeQuantityNumber(range[1])}-${normalizeQuantityNumber(range[2])}mts`
  }

  const matches = Array.from(value.matchAll(/\b(\d+(?:[,.]\d+)?)\s*(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?)\b/gi))
    .map((match) => match[1])
    .filter(isUsableQuantityNumber)

  const quantity = matches.at(-1)
  return quantity ? `${normalizeQuantityNumber(quantity)}mts` : ""
}

function extractQuantityFromBlock(lines: string[]) {
  const inlineQuantity = extractQuantityFromInlineUnit(lines.join(" "))
  if (inlineQuantity) return inlineQuantity

  const unitIndex = lines.findIndex((line) => /^(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?)$/i.test(line))
  const scanLines = unitIndex >= 0 ? lines.slice(1, unitIndex) : lines.slice(1)
  const numericLine = scanLines
    .map((line) => line.match(/^\d+(?:[,.]\d+)?$/)?.[0] || "")
    .find((value) => value && isUsableQuantityNumber(value))

  return numericLine ? `${normalizeQuantityNumber(numericLine)}mts` : ""
}

function productMatches(line: string) {
  return Array.from(
    line.matchAll(/(?:hsfo|hfo|ifo|v\s*l\s*s\s*f\s*o|vlsfo|lsfo|l\s*s\s*m\s*g\s*o|lsmgo|lemgo|mgo|mdo|dma|dmb|rmg\s*180|rmg\s*380|180\s*cst|120\s*cst)/gi),
  )
    .map((match) => ({
      index: match.index ?? -1,
      value: match[0],
      product: classifyProduct(match[0]),
    }))
    .filter((match): match is { index: number; value: string; product: ProductSegment["product"] } =>
      match.index >= 0 && Boolean(match.product),
    )
}

function extractInlineProductSegments(line: string, autoDetectVlsfoRemarks: boolean) {
  const matches = productMatches(line)
  if (matches.length < 2) return []

  return matches.flatMap((match, index) => {
    const nextMatch = matches[index + 1]
    const segmentText = line.slice(match.index, nextMatch?.index ?? line.length)
    const quantity = extractQuantityFromInlineUnit(segmentText)
    if (!quantity) return []

    return [{
      product: match.product,
      quantity,
      detectedRemarks:
        autoDetectVlsfoRemarks && match.product === "vlsfo"
          ? detectVlsfoMaxRemarks(segmentText)
          : [],
    }]
  })
}

function extractProducts(text: string, autoDetectVlsfoRemarks: boolean) {
  const lines = normalizeInput(text)
    .split("\n")
    .map(cleanSpaces)
    .filter(Boolean)

  const products: ProductSegment[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const inlineSegments = extractInlineProductSegments(line, autoDetectVlsfoRemarks)
    if (inlineSegments.length > 0) {
      products.push(...inlineSegments)
      continue
    }

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

      if (/^(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?)$/i.test(nextLine) || /\b(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?)\b/i.test(nextLine)) break
    }

    const quantity = extractQuantityFromBlock(block)
    if (quantity) {
      products.push({
        product,
        quantity,
        detectedRemarks:
          autoDetectVlsfoRemarks && product === "vlsfo"
            ? detectVlsfoMaxRemarks(block.join(" "))
            : [],
      })
    }

    index = endIndex
  }

  return products
}

function mergeRemarks(...remarkGroups: VlsfoMaxRemark[][]) {
  return Array.from(new Set(remarkGroups.flat()))
}

export function formatVlsfoMaxRemark(remark: VlsfoMaxRemark) {
  return remark === "180cst max" ? "180CST MAX" : "120CST MAX"
}

function formatProductSegment(segment: ProductSegment, manualVlsfoRemarks: VlsfoMaxRemark[]) {
  if (segment.product === "hsfo") return `HSFO ${segment.quantity}`
  if (segment.product !== "vlsfo") return `${segment.product} ${segment.quantity}`

  const remarks = mergeRemarks(segment.detectedRemarks, manualVlsfoRemarks)
  return [segment.product, ...remarks.map(formatVlsfoMaxRemark), segment.quantity].join(" ")
}

export function buildShortenedEnquiry(
  sourceText: string,
  vesselName: string,
  imo: string,
  manualVlsfoRemarks: VlsfoMaxRemark[] = [],
  options: BuildShortenedEnquiryOptions = {},
) {
  const autoDetectVlsfoRemarks = options.autoDetectVlsfoRemarks !== false
  const date = extractDeliveryDate(sourceText)
  const port = options.includePort
    ? (options.port?.trim() || extractEnquiryPort(sourceText, { portNames: options.portNames }))
    : ""
  const portAndDate = [port, date].filter(Boolean).join(" ")
  const products = extractProducts(sourceText, autoDetectVlsfoRemarks)
    .map((product) => formatProductSegment(product, manualVlsfoRemarks))

  return [vesselName.toLowerCase(), imo, portAndDate || date, ...products]
    .filter(Boolean)
    .join(" / ")
}
