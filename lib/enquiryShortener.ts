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

const QUANTITY_UNIT_PATTERN = String.raw`(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?|[吨噸])`

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
    .replace(/[–—‐‑‒–—―−﹘﹣－]/g, "-")
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

function formatShortenedPort(value: string) {
  const normalized = cleanSpaces(value).toLowerCase()
  return normalized === "hong kong" || normalized === "hongkong" || normalized === "hkg" ? "hk" : normalized
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

function currentMonthKey() {
  return String(new Date().getMonth() + 1)
}

function normalizeCurrentMonthDate(day: string) {
  return normalizeDate(day, currentMonthKey())
}

function formatCurrentMonthDateRange(firstDay: string, secondDay: string) {
  return formatDateRange(firstDay, currentMonthKey(), secondDay, currentMonthKey())
}

function isContactOrAddressLine(value: string) {
  return /^(?:add|address|voice|voice\/fax|fax|mobile|phone|tel|e-?mail)\b/i.test(value) ||
    /[\w.-]+@[\w.-]+/.test(value) ||
    /\+\d{1,3}[-\d\s]{5,}/.test(value)
}

function findDates(value: string) {
  const normalized = normalizeInput(value).replace(/\[[^\]]*\d{1,2}:\d{2}[^\]]*\]/g, " ")
  const dates: string[] = []
  const monthNamePattern = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"

  for (const match of normalized.matchAll(/(?:^|\n)\s*[A-Za-z][A-Za-z .'-]{1,36}\s+(\d{1,2})[./](\d{1,2})(?=$|[^\d])/gm)) {
    const date = normalizeDate(match[2], match[1])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    const date = normalizeDate(match[2], match[1])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})\s*(?:-|~|to|至|到)\s*(\d{1,2})\s*[日号]/gi)) {
    const range = formatCurrentMonthDateRange(match[1], match[2])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})\s*[日号]/g)) {
    const date = normalizeCurrentMonthDate(match[1])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNamePattern})\\s*(?:,?\\s*\\d{2,4})?(?:\\s*\\([^)]*\\))?\\s*(?:-|~|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNamePattern})\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[2], match[3], match[4])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})[./](\d{1,2})\s*(?:-|~|\/|to)\s*(?:(\d{1,2})[./])?(\d{1,2})\b/gi)) {
    const rangeMonth = match[3] || match[1]
    const range = formatDateRange(match[2], match[1], match[4], rangeMonth)
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})\\s*(?:-|~|to)\\s*(\\d{1,2})[./-](\\d{1,2}|${monthNamePattern})(?:[./-]\\d{2,4})?\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[3], match[2], match[3])
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

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthNamePattern})\\b`, "gi"))) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-]\d{2,4})?\b(?!\s*[日号])/g)) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+|\s*[- ]\s*)(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi)) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi)) {
    const date = normalizeCurrentMonthDate(match[1])
    if (date) dates.push(date)
  }

  return Array.from(new Set(dates))
}

function extractDeliveryDate(text: string) {
  const lines = normalizeInput(text)
    .split("\n")
    .map(cleanSpaces)
    .filter(Boolean)

  const candidateLines = lines.filter((line) => !isContactOrAddressLine(line))
  const labelledLines = candidateLines.filter((line) =>
    /^\s*(?:delivery|window|date|eta|etb|etd|ets)\b/i.test(line),
  )
  const dates = findDates(labelledLines.join(" ") || candidateLines.join("\n"))

  return dates[0] || ""
}

function extractDeliverySchedule(
  text: string,
  options: Pick<BuildShortenedEnquiryOptions, "includePort" | "portNames"> = {},
) {
  const lines = normalizeInput(text)
    .split("\n")
    .map(cleanSpaces)
    .filter(Boolean)
    .filter((line) => !isContactOrAddressLine(line))

  const entries: string[] = []
  for (const line of lines) {
    const date = findDates(line)[0] || ""
    if (!date) continue

    if (options.includePort) {
      const port = extractEnquiryPort(line, { portNames: options.portNames })
      if (!port) continue
      entries.push(`${formatShortenedPort(port)} ${date}`)
      continue
    }

    entries.push(date)
  }

  return Array.from(new Set(entries)).join(", ")
}

function classifyProduct(value: string): ProductSegment["product"] | "" {
  const compact = value.toLowerCase().replace(/\s+/g, "")
  if (/(?:lsmgo|lemgo|mgo|mdo|dma|dmb)/i.test(compact)) return "lsmgo"
  if (/(?:hsfo|hfo|ifo|3[,.]?5)/i.test(compact)) return "hsfo"
  if (/(?:vlsfo|lsfo|0[,.]?5|0[,.]?50|rmg180|rmg380|180cst|120cst|ls(?:120|180)c+s+t)/i.test(compact)) {
    return "vlsfo"
  }
  return ""
}

function containsProduct(value: string) {
  return Boolean(classifyProduct(value))
}

function isSulphurSpecLine(value: string) {
  return /\bsulphur|sulfur\b/i.test(value) || /^\s*:\s*(?:min|max)\s*\d/i.test(value)
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

export function detectAttentionTerms(value: string) {
  const normalized = normalizeInput(value)
  const terms: string[] = []
  if (/\br\s*\.?\s*m\s*\.?\s*k\s*s?\b/i.test(normalized)) terms.push("RMK")
  if (/\bc\s*\.?\s*b\s*\.?\s*m\b/i.test(normalized)) terms.push("CBM")
  if (/\bk\s*\.?\s*l\b/i.test(normalized)) terms.push("KL")
  return terms
}

function extractQuantityFromInlineUnit(value: string) {
  const range = value.match(new RegExp(String.raw`\b(\d+(?:[,.]\d+)?)\s*(?:-|~|to)\s*(\d+(?:[,.]\d+)?)\s*${QUANTITY_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "i"))
  if (range) {
    return `${normalizeQuantityNumber(range[1])}-${normalizeQuantityNumber(range[2])}mts`
  }

  const matches = Array.from(value.matchAll(new RegExp(String.raw`\b(\d+(?:[,.]\d+)?)\s*${QUANTITY_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "gi")))
    .map((match) => match[1])
    .filter(isUsableQuantityNumber)

  const quantity = matches.at(-1)
  return quantity ? `${normalizeQuantityNumber(quantity)}mts` : ""
}

function extractQuantityFromBlock(lines: string[]) {
  const inlineQuantity = extractQuantityFromInlineUnit(lines.join(" "))
  if (inlineQuantity) return inlineQuantity

  const unitIndex = lines.findIndex((line) => new RegExp(String.raw`^${QUANTITY_UNIT_PATTERN}$`, "i").test(line))
  const scanLines = unitIndex >= 0 ? lines.slice(1, unitIndex) : lines.slice(1)
  const numericLine = scanLines
    .map((line) => line.match(/^\d+(?:[,.]\d+)?$/)?.[0] || "")
    .find((value) => value && isUsableQuantityNumber(value))

  return numericLine ? `${normalizeQuantityNumber(numericLine)}mts` : ""
}

function productMatches(line: string) {
  return Array.from(
    line.matchAll(/(?:hsfo|hfo|ifo|v\s*l\s*s\s*f\s*o|vlsfo|lsfo|l\s*s\s*m\s*g\s*o|lsmgo|lemgo|mgo|mdo|dma|dmb|rmg\s*180|rmg\s*380|180\s*cst|120\s*cst|l\s*s\s*(?:120|180)\s*c\s*s+\s*t)/gi),
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
      if (containsProduct(nextLine) && !isSulphurSpecLine(nextLine)) break
      if (isLabelLine(nextLine) && !isSulphurSpecLine(nextLine) && !/^(?:product|qty|quantity)\b/i.test(nextLine)) break

      block.push(nextLine)
      endIndex = offset

      if (new RegExp(String.raw`^${QUANTITY_UNIT_PATTERN}$`, "i").test(nextLine) || new RegExp(String.raw`${QUANTITY_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "i").test(nextLine)) break
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
    ? formatShortenedPort(options.port?.trim() || extractEnquiryPort(sourceText, { portNames: options.portNames }))
    : ""
  const schedule = extractDeliverySchedule(sourceText, options)
  const portAndDate = schedule || [port, date].filter(Boolean).join(" ")
  const products = extractProducts(sourceText, autoDetectVlsfoRemarks)
    .map((product) => formatProductSegment(product, manualVlsfoRemarks))

  return [vesselName.toLowerCase(), imo, portAndDate || date, ...products]
    .filter(Boolean)
    .join(" / ")
}
