import { extractEnquiryPort } from "@/lib/enquiryWorksheetParser"

export type VlsfoMaxRemark = "80cst min" | "80cst max" | "120cst max" | "180cst max"

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

const QUANTITY_UNIT_PATTERN = String.raw`(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?|c\s*\.?\s*b\s*\.?\s*m|k\s*\.?\s*l|[吨噸])`
const KL_UNIT_PATTERN = String.raw`k\s*\.?\s*l`
const EXPLICIT_PORT_LINE_PATTERN =
  /^\s*(?:port|position|location|bunker(?:ing)?\s*(?:port|location|place)|port\s+of\s+(?:call|delivery|supply)|delivery\s+(?:port|place|location)|place\s+of\s+(?:supply|delivery)|supply\s+(?:port|place|location)|loading\s+port|discharging\s+port|加油港口|港口|地点|地點)(?:\s|[:#(（-]|$)/i
const OPERATIONAL_SCHEDULE_LINE_PATTERN =
  /^\s*((?:e\s*\.?\s*t\s*\.?\s*(?:a|b|d|s|c(?:\s*\.?\s*d)?)|a\s*\.?\s*t\s*\.?\s*a)\s*\.?)\s*[:#-]?\s*(.*)$/i

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
  agu: "aug",
  agust: "aug",
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

const MAX_DAY_BY_MONTH: Record<string, number> = {
  jan: 31,
  feb: 29,
  mar: 31,
  apr: 30,
  may: 31,
  jun: 30,
  jul: 31,
  aug: 31,
  sep: 30,
  oct: 31,
  nov: 30,
  dec: 31,
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
    .replace(/[，]/g, ",")
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

function normalizeQuantityNumericText(value: string) {
  const compact = value.replace(/\s+/g, "").trim()
  if (/^0[,.]\d+$/.test(compact)) return compact.replace(",", ".")
  if (/^[1-9]\d{0,2}(?:[,.]\d{3})+$/.test(compact)) return compact.replace(/[,.]/g, "")
  if (/^\d+,\d{1,2}$/.test(compact)) return compact.replace(",", ".")
  return compact.replace(/,/g, "")
}

export function normalizeEnquiryQuantityNumber(value: string) {
  const normalized = normalizeQuantityNumericText(value)
  if (/^\d+\.0+$/.test(normalized)) return normalized.split(".")[0]
  if (/^\d+$/.test(normalized) && Number(normalized) >= 1000) {
    return Number(normalized).toLocaleString("en-US")
  }
  return normalized
}

export function normalizeEnquiryQuantityText(value: string) {
  return value.replace(
    /\b(\d+(?:[,.]\d+)?)\s*(?:[-/]\s*(\d+(?:[,.]\d+)?))?\s*(mt|mts)\b/gi,
    (_match, first: string, second: string | undefined) => {
      const quantity = second
        ? `${normalizeEnquiryQuantityNumber(first)}-${normalizeEnquiryQuantityNumber(second)}`
        : normalizeEnquiryQuantityNumber(first)
      return `${quantity}mts`
    },
  )
}

function numericValue(value: string) {
  const normalized = normalizeQuantityNumericText(value)
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function isUsableQuantityNumber(value: string) {
  const parsed = numericValue(value)
  return parsed !== null && parsed >= 1
}

function normalizeDate(day: string, month: string) {
  const normalizedMonth = validDateParts(day, month)
  const normalizedDay = Number(day)
  if (!normalizedMonth) return ""
  return `${normalizedDay} ${normalizedMonth}`
}

function validDateParts(day: string, month: string) {
  const normalizedMonth = MONTHS[month.toLowerCase()]
  const normalizedDay = Number(day)
  if (!normalizedMonth || !Number.isInteger(normalizedDay)) return ""
  if (normalizedDay < 1 || normalizedDay > MAX_DAY_BY_MONTH[normalizedMonth]) return ""
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
    /\+\d{1,3}[-\d\s]{5,}/.test(value) ||
    /\b\d+(?:st|nd|rd|th)\s+(?:flr|floor)\b/i.test(value) ||
    /\b(?:flr|floor|suite|unit|building|bldg|street|road|avenue|district|postal\s+code)\b/i.test(value)
}

function monthTokenFollowsDay(value: string, monthIndex: number) {
  return /\b\d{1,2}(?:st|nd|rd|th)?\s+$/i.test(
    value.slice(Math.max(0, monthIndex - 8), monthIndex),
  )
}

export function findEnquiryDates(value: string) {
  const normalized = normalizeInput(value).replace(/\[[^\]]*\d{1,2}:\d{2}[^\]]*\]/g, " ")
  const dates: string[] = []
  const monthNamePattern = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|agu(?:st)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"

  for (const match of normalized.matchAll(/(?<!\d)(\d{1,2})[./](\d{1,2})\s*(?:-|~|to)\s*(\d{1,2})[./](\d{1,2})(?![./]\d)/gi)) {
    const range = formatDateRange(match[2], match[1], match[4], match[3])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNamePattern})\\s*\\/\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNamePattern})\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[2], match[3], match[4])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(/(?:\d{4}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(?:-|~|to|至|到)\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号]/gi)) {
    const range = formatDateRange(match[2], match[1], match[4], match[3] || match[1])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(/(?:\d{4}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) {
    const date = normalizeDate(match[2], match[1])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b\d{4}[./-](\d{1,2})[./-](\d{1,2})\b/g)) {
    const date = normalizeDate(match[2], match[1])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*\\/\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${monthNamePattern})\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[3], match[2], match[3])
    if (range) dates.push(range)
  }

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

  for (const match of normalized.matchAll(new RegExp(`\\b(${monthNamePattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|~|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"))) {
    const range = formatDateRange(match[2], match[1], match[3], match[1])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*[./]\\s*(${monthNamePattern})\\s*(?:-|~|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*[./]\\s*(${monthNamePattern})\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[2], match[3], match[4])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?\s*(?:-|~|to)\s*(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?\b/gi)) {
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

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|~|to)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*[,/]\\s*(${monthNamePattern})\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[3], match[2], match[3])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|~|to)\s*(\d{1,2})(?:st|nd|rd|th)\b/gi)) {
    const range = formatCurrentMonthDateRange(match[1], match[2])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})\\s*\\/\\s*(\\d{1,2})[./-](\\d{1,2}|${monthNamePattern})(?:[./-]\\d{2,4})?\\b`, "gi"))) {
    const range = formatDateRange(match[1], match[3], match[2], match[3])
    if (range) dates.push(range)
  }

  for (const match of normalized.matchAll(new RegExp(`(?<![\\d/.-])\\b(${monthNamePattern})\\s*[./-]\\s*(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:\\s*['’]\\d{2,4}|\\s+\\d{4})?\\b`, "gi"))) {
    if (monthTokenFollowsDay(normalized, match.index ?? 0)) continue
    const date = normalizeDate(match[2], match[1])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(${monthNamePattern})\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"))) {
    if (monthTokenFollowsDay(normalized, match.index ?? 0)) continue
    const date = normalizeDate(match[2], match[1])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s*[./-]?\\s*(${monthNamePattern})\\b`, "gi"))) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthNamePattern})\\b`, "gi"))) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-]\d{2,4})?\b(?!\s*[日号])/g)) {
    const date = normalizeDate(match[1], match[2]) || normalizeDate(match[2], match[1])
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
    /^\s*(?:delivery|window|dates?)\b/i.test(line) || OPERATIONAL_SCHEDULE_LINE_PATTERN.test(line),
  )
  const dates = findEnquiryDates(labelledLines.join(" ") || candidateLines.join("\n"))

  return dates[0] || ""
}

type OperationalScheduleEntry = {
  label: "eta" | "etb" | "etd"
  date: string
}

function extractOperationalSchedule(lines: string[]) {
  const entries = new Map<OperationalScheduleEntry["label"], OperationalScheduleEntry>()

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(OPERATIONAL_SCHEDULE_LINE_PATTERN)
    if (!match) continue

    const rawLabel = match[1].replace(/[^a-z]/gi, "").toLowerCase()
    const label: OperationalScheduleEntry["label"] = rawLabel === "eta" || rawLabel === "ata"
      ? "eta"
      : rawLabel === "etb" ? "etb" : "etd"
    const inlineValue = match[2].trim()
    const date = findEnquiryDates(inlineValue)[0] ||
      (!inlineValue ? findEnquiryDates(lines[index + 1] || "")[0] : "") ||
      ""
    if (date && !entries.has(label)) entries.set(label, { label, date })
  }

  return Array.from(entries.values())
}

function formatOperationalWindow(firstDate: string, secondDate: string) {
  const first = firstDate.match(/^(\d{1,2})\s+([a-z]{3})$/i)
  const second = secondDate.match(/^(\d{1,2})\s+([a-z]{3})$/i)
  if (!first || !second) return ""
  return formatDateRange(first[1], first[2], second[1], second[2])
}

function operationalDateBounds(value: string) {
  const crossMonth = value.match(/^(\d{1,2})\s+([a-z]{3})\s+-\s+(\d{1,2})\s+([a-z]{3})$/i)
  if (crossMonth) {
    return {
      start: `${Number(crossMonth[1])} ${crossMonth[2].toLowerCase()}`,
      end: `${Number(crossMonth[3])} ${crossMonth[4].toLowerCase()}`,
    }
  }

  const sameMonth = value.match(/^(\d{1,2})\s+-\s+(\d{1,2})\s+([a-z]{3})$/i)
  if (sameMonth) {
    const month = sameMonth[3].toLowerCase()
    return {
      start: `${Number(sameMonth[1])} ${month}`,
      end: `${Number(sameMonth[2])} ${month}`,
    }
  }

  const single = value.match(/^(\d{1,2})\s+([a-z]{3})$/i)
  if (!single) return null
  const date = `${Number(single[1])} ${single[2].toLowerCase()}`
  return { start: date, end: date }
}

function extractAlternativeCaseSchedule(
  lines: string[],
  options: Pick<BuildShortenedEnquiryOptions, "includePort" | "portNames">,
) {
  const caseIndexes = lines
    .map((line, index) => /^\s*\[\s*case\s+\d+\s*\]\s*:?\s*$/i.test(line) ? index : -1)
    .filter((index) => index >= 0)
  if (caseIndexes.length < 2) return ""

  const entries = caseIndexes.flatMap((startIndex, caseIndex) => {
    const endIndex = caseIndexes[caseIndex + 1] ?? lines.length
    const block = lines.slice(startIndex + 1, endIndex)
    const dateLine = block.find((line) =>
      OPERATIONAL_SCHEDULE_LINE_PATTERN.test(line) || /^\s*(?:delivery|window|date)\b/i.test(line),
    )
    const date = findEnquiryDates(dateLine || "")[0] || ""
    if (!date) return []

    const port = options.includePort
      ? formatShortenedPort(extractEnquiryPort(block.join("\n"), { portNames: options.portNames }))
      : ""
    return [[port, date].filter(Boolean).join(" ")]
  })

  return entries.length > 1 ? Array.from(new Set(entries)).join(" OR ") : ""
}

function extractDeliverySchedule(
  text: string,
  options: Pick<BuildShortenedEnquiryOptions, "includePort" | "port" | "portNames"> = {},
) {
  const lines = normalizeInput(text)
    .split("\n")
    .map(cleanSpaces)
    .filter(Boolean)
    .filter((line) => !isContactOrAddressLine(line))
  const operationalNotesIndex = lines.findIndex((line) => /^operational\s+notes?\s*:?s*$/i.test(line))
  const scheduleLines = operationalNotesIndex >= 0 ? lines.slice(0, operationalNotesIndex) : lines

  const alternativeCaseSchedule = extractAlternativeCaseSchedule(scheduleLines, options)
  if (alternativeCaseSchedule) return alternativeCaseSchedule

  const operationalSchedule = extractOperationalSchedule(scheduleLines)
  if (operationalSchedule.length > 1) {
    const port = options.includePort
      ? formatShortenedPort(options.port?.trim() || extractEnquiryPort(text, { portNames: options.portNames }))
      : ""
    const eta = operationalSchedule.find((entry) => entry.label === "eta")
    const etb = operationalSchedule.find((entry) => entry.label === "etb")
    const etd = operationalSchedule.find((entry) => entry.label === "etd")
    const etaBounds = eta ? operationalDateBounds(eta.date) : null
    const etdBounds = etd ? operationalDateBounds(etd.date) : null
    const fullMovementWindow = eta && etb && etd && etaBounds && etdBounds
      ? formatOperationalWindow(etaBounds.start, etdBounds.end)
      : ""
    if (fullMovementWindow) return [port, fullMovementWindow].filter(Boolean).join(" ")

    const hasExplicitEtd = scheduleLines.some((line) => {
      const match = line.match(OPERATIONAL_SCHEDULE_LINE_PATTERN)
      return match?.[1].replace(/[^a-z]/gi, "").toLowerCase() === "etd"
    })
    const usesDeliveryWindowTemplate = /\bgrades?\s+and\s+quantities\b/i.test(text)
    const window = usesDeliveryWindowTemplate && hasExplicitEtd &&
      operationalSchedule.length === 2 && eta && etd
      ? formatOperationalWindow(eta.date, etd.date)
      : ""
    if (window) return [port, window].filter(Boolean).join(" ")

    const events = operationalSchedule.map((entry) => `${entry.label} ${entry.date}`).join(", ")
    return [port, events].filter(Boolean).join(" ")
  }

  const entries: Array<{ port: string; date: string }> = []
  for (const line of scheduleLines) {
    const date = findEnquiryDates(line)[0] || ""
    if (!date) continue

    if (options.includePort) {
      const port = extractEnquiryPort(line, { portNames: options.portNames })
      if (!port) continue
      entries.push({ port: formatShortenedPort(port), date })
      continue
    }

    entries.push({ port: "", date })
  }

  const requestedPort = options.includePort ? formatShortenedPort(options.port?.trim() || "") : ""
  const hasExplicitRequestedPort = requestedPort && scheduleLines.some((line) =>
    EXPLICIT_PORT_LINE_PATTERN.test(line) &&
    formatShortenedPort(extractEnquiryPort(line, { portNames: options.portNames })) === requestedPort,
  )
  const requestedPortEntries = hasExplicitRequestedPort
    ? entries.filter((entry) => entry.port === requestedPort)
    : []
  const selectedEntries = requestedPortEntries.length > 0 ? requestedPortEntries : entries

  const fallbackPort = requestedPort && selectedEntries.every((entry) => !entry.port)
    ? requestedPort
    : ""
  const uniqueEntries = Array.from(
    new Set(selectedEntries.map((entry) => [entry.port || fallbackPort, entry.date].filter(Boolean).join(" "))),
  )
  const distinctPorts = new Set(selectedEntries.map((entry) => entry.port || fallbackPort).filter(Boolean))
  return uniqueEntries.join(distinctPorts.size > 1 ? " OR " : ", ")
}

function classifyProduct(value: string): ProductSegment["product"] | "" {
  const compact = value.toLowerCase().replace(/\s+/g, "")
  if (/(?:lsmgo|lemgo|lsgo|mgo|mdo|dma|dmb|gasoil)/i.test(compact)) return "lsmgo"
  if (/(?:vlsfo|vslfo|lsmfo|lsfo|rmg180|180cst|120cst|ls(?:80|120|180|200)c+s+t)/i.test(compact) || /(?:^|\D)80\s*cst\b/i.test(value) || /(?:^|[^0-9])0\s*[,.]\s*5(?:0)?(?=$|[^0-9])/i.test(value)) {
    return "vlsfo"
  }
  if (/\b(?:hsfo|hfo|ifo|rmk)(?:\s*\d{2,3})?\b/i.test(value) || /(?:^|[^0-9])s?\s*3\s*[,.]\s*5(?:0)?(?=$|[^0-9])/i.test(value)) {
    return "hsfo"
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

function isNonRequestProductReference(value: string) {
  const normalized = value.replace(/^\s*(?:[-*.]+\s*)+/, "")
  const hasExplicitQuantity = new RegExp(String.raw`\d+(?:[,.]\d+)?\s*${QUANTITY_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "i").test(normalized)
  if (hasExplicitQuantity) return false

  return /^\s*(?:(?:remarks?|r\s*\.?\s*m\s*\.?\s*k\s*\.?|spec(?:ification)?|fuel\s+standard)\b|燃油标准)\s*[:：]?/i.test(normalized) ||
    /^\s*(?:hsfo|hfo|ifo|v\s*l\s*s\s*f\s*o|vlsfo|vslfo|lsmfo|lsfo|l\s*s\s*m\s*g\s*o|lsmgo|lemgo|lsgo|mgo|mdo|dma|dmb)\s+spec(?:ification)?\b/i.test(normalized) ||
    /^\s*(?:fuel|diesel)\s+oils?\b.*\bspecs?\b/i.test(normalized) ||
    /(?:\b(?:please|kindly)\b.*\bbunker(?:ing)?\b|\bbunker(?:ing)?\s+carry\s+out\b)/i.test(normalized) ||
    /\b(?:attach|certificate|coq|flash\s+point|quality\s+claims?|for\s+guidance)\b/i.test(normalized)
}

export function detectVlsfoMaxRemarks(value: string): VlsfoMaxRemark[] {
  const normalized = normalizeInput(value)
  const remarks: VlsfoMaxRemark[] = []
  if (/\b80\s*cst\s*min\b/i.test(normalized)) {
    remarks.push("80cst min")
  } else if (/(?:^|[^0-9])(?:rmg\s*)?80\s*cst\b/i.test(normalized) || /\brmg\s*80\b/i.test(normalized)) {
    remarks.push("80cst max")
  }
  if (/(?:^|[^0-9])(?:rmg\s*)?180\s*cst\b/i.test(normalized) || /\brmg\s*180\b/i.test(normalized)) {
    remarks.push("180cst max")
  }
  if (/(?:^|[^0-9])(?:rmg\s*)?120\s*cst\b/i.test(normalized) || /\brmg\s*120\b/i.test(normalized)) {
    remarks.push("120cst max")
  }
  return remarks
}

export function hasVlsfoMaxCaution(value: string) {
  return /(^|\D)(?:80|120|180)(?!\d)/.test(value)
}

export function detectSpcCautionTerms(value: string) {
  const terms: string[] = []
  if (/(^|\D)80(?!\d)/.test(value)) terms.push("80")
  if (/(^|\D)120(?!\d)/.test(value)) terms.push("120")
  if (/(^|\D)180(?!\d)/.test(value)) terms.push("180")
  if (/\br\s*\.?\s*m\s*\.?\s*k\s*\.?s?\b/i.test(value)) terms.push("RMK")
  return terms
}

export function formatSpcCautionWarning(terms: string[]) {
  const hasViscosity = terms.some((term) => term === "80" || term === "120" || term === "180")
  const hasRmk = terms.includes("RMK")
  const requirement = hasViscosity && hasRmk
    ? "VLSFO viscosity and RMK requirements"
    : hasViscosity
      ? "VLSFO viscosity requirement"
      : "RMK requirement"

  return `WARNING: ${terms.join(" / ")} spotted. Confirm ${requirement} before sending.`
}

export function replaceHsfoWithRmk(value: string) {
  return value.replace(/\bhsfo\b/i, "RMK")
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
  const klRange = value.match(new RegExp(String.raw`\b(\d+(?:[,.]\d+)?)\s*(?:-|~|/|to)\s*(\d+(?:[,.]\d+)?)\s*${KL_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "i"))
  if (klRange) {
    return `${normalizeEnquiryQuantityNumber(klRange[1])}-${normalizeEnquiryQuantityNumber(klRange[2])}kl`
  }

  const klMatches = Array.from(value.matchAll(new RegExp(String.raw`\b(\d+(?:[,.]\d+)?)\s*${KL_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "gi")))
    .map((match) => match[1])
    .filter(isUsableQuantityNumber)
  const klQuantity = klMatches.at(-1)
  if (klQuantity) return `${normalizeEnquiryQuantityNumber(klQuantity)}kl`

  const range = value.match(new RegExp(String.raw`\b(\d+(?:[,.]\d+)?)\s*(?:-|~|/|to)\s*(\d+(?:[,.]\d+)?)\s*${QUANTITY_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "i"))
  if (range) {
    return `${normalizeEnquiryQuantityNumber(range[1])}-${normalizeEnquiryQuantityNumber(range[2])}mts`
  }

  const matches = Array.from(value.matchAll(new RegExp(String.raw`\b(\d+(?:[,.]\d+)?)\s*${QUANTITY_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "gi")))
    .map((match) => match[1])
    .filter(isUsableQuantityNumber)

  const quantity = matches.at(-1)
  return quantity ? `${normalizeEnquiryQuantityNumber(quantity)}mts` : ""
}

function extractBareQuantity(value: string) {
  const quantityText = value
    .replace(/\biso\s*[-:]?\s*\d{3,5}(?:\s*[-:/]?\s*\d{2,4})?\b/gi, " ")
    .replace(/\b(?:rmg|rmk|dma|dmb)\s*[-:]?\s*\d+(?:[,.]\d+)?\b/gi, " ")
    .replace(/\b\d+(?:[,.]\d+)?\s*(?:cst|centistokes?)\b/gi, " ")
    .replace(/\b(?:sulphur|sulfur|flash\s+point|density)\b[^\n;/]*/gi, " ")
  const ranges = Array.from(quantityText.matchAll(/(?<![\d.,])(\d+(?:[,.]\d+)?)\s*(?:-|~|\/|to)\s*(\d+(?:[,.]\d+)?)(?!\s*%|[\d.,])/gi))
    .filter((match) => isUsableQuantityNumber(match[1]) && isUsableQuantityNumber(match[2]))
  const range = ranges.at(-1)
  if (range) return `${normalizeEnquiryQuantityNumber(range[1])}-${normalizeEnquiryQuantityNumber(range[2])}mts`

  const numbers = Array.from(quantityText.matchAll(/(?<![\d.,])(\d+(?:[,.]\d+)?)(?!\s*(?:%|cst\b)|[\d.,])/gi))
    .map((match) => match[1])
    .filter(isUsableQuantityNumber)
  const quantity = numbers.at(-1)
  return quantity ? `${normalizeEnquiryQuantityNumber(quantity)}mts` : ""
}

function extractQuantityFromProductSegment(value: string) {
  return extractQuantityFromInlineUnit(value) || extractBareQuantity(value)
}

function extractQuantityImmediatelyBeforeProduct(value: string) {
  const klRange = value.match(new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(?:-|~|/|to)\s*(\d+(?:[,.]\d+)?)\s*${KL_UNIT_PATTERN}\s*$`, "i"))
  if (klRange && isUsableQuantityNumber(klRange[1]) && isUsableQuantityNumber(klRange[2])) {
    return `${normalizeEnquiryQuantityNumber(klRange[1])}-${normalizeEnquiryQuantityNumber(klRange[2])}kl`
  }

  const klSingle = value.match(new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*${KL_UNIT_PATTERN}\s*$`, "i"))
  if (klSingle && isUsableQuantityNumber(klSingle[1])) {
    return `${normalizeEnquiryQuantityNumber(klSingle[1])}kl`
  }

  const range = value.match(new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*(?:-|~|/|to)\s*(\d+(?:[,.]\d+)?)\s*${QUANTITY_UNIT_PATTERN}\s*$`, "i"))
  if (range && isUsableQuantityNumber(range[1]) && isUsableQuantityNumber(range[2])) {
    return `${normalizeEnquiryQuantityNumber(range[1])}-${normalizeEnquiryQuantityNumber(range[2])}mts`
  }

  const single = value.match(new RegExp(String.raw`(\d+(?:[,.]\d+)?)\s*${QUANTITY_UNIT_PATTERN}\s*$`, "i"))
  return single && isUsableQuantityNumber(single[1])
    ? `${normalizeEnquiryQuantityNumber(single[1])}mts`
    : ""
}

function extractBareRangeImmediatelyBeforeProduct(value: string) {
  const range = value.match(/(\d+(?:[,.]\d+)?)\s*(?:-|~|\/|to)\s*(\d+(?:[,.]\d+)?)\s*$/i)
  return range && isUsableQuantityNumber(range[1]) && isUsableQuantityNumber(range[2])
    ? `${normalizeEnquiryQuantityNumber(range[1])}-${normalizeEnquiryQuantityNumber(range[2])}mts`
    : ""
}

function extractBareQuantityImmediatelyBeforeProduct(value: string) {
  const single = value.match(/(\d+(?:[,.]\d+)?)\s*$/)
  return single && isUsableQuantityNumber(single[1])
    ? `${normalizeEnquiryQuantityNumber(single[1])}mts`
    : ""
}

function extractQuantityImmediatelyAfterProduct(value: string) {
  const range = value.match(new RegExp(String.raw`^\s*[:#-]?\s*(\d+(?:[,.]\d+)?)\s*(?:-|~|/|to)\s*(\d+(?:[,.]\d+)?)\s*(?:${QUANTITY_UNIT_PATTERN})?`, "i"))
  if (range && isUsableQuantityNumber(range[1]) && isUsableQuantityNumber(range[2])) {
    return `${normalizeEnquiryQuantityNumber(range[1])}-${normalizeEnquiryQuantityNumber(range[2])}mts`
  }

  const single = value.match(new RegExp(String.raw`^\s*[:#-]?\s*(\d+(?:[,.]\d+)?)\s*(?:${QUANTITY_UNIT_PATTERN})?`, "i"))
  if (!single || !isUsableQuantityNumber(single[1])) return ""
  const remainder = value.slice(single[0].length)
  if (/^\s*(?:%|cst\b|centistokes?\b)/i.test(remainder)) return ""
  return `${normalizeEnquiryQuantityNumber(single[1])}mts`
}

function extractQuantityFromBlock(lines: string[]) {
  const inlineQuantity = extractQuantityFromProductSegment(lines.join(" "))
  if (inlineQuantity) return inlineQuantity

  const unitIndex = lines.findIndex((line) => new RegExp(String.raw`^${QUANTITY_UNIT_PATTERN}$`, "i").test(line))
  const scanLines = unitIndex >= 0 ? lines.slice(1, unitIndex) : lines.slice(1)
  const numericLine = scanLines
    .map((line) => line.match(/^\d+(?:[,.]\d+)?$/)?.[0] || "")
    .find((value) => value && isUsableQuantityNumber(value))

  return numericLine ? `${normalizeEnquiryQuantityNumber(numericLine)}mts` : ""
}

function extractExplicitQuantityList(value: string) {
  const pattern = new RegExp(
    String.raw`\b\d+(?:[,.]\d+)?(?:\s*(?:-|~|/|to)\s*\d+(?:[,.]\d+)?)?\s*${QUANTITY_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`,
    "gi",
  )

  return Array.from(value.matchAll(pattern)).flatMap((match) => {
    const quantity = extractQuantityFromInlineUnit(match[0])
    return quantity ? [quantity] : []
  })
}

function extractPairedProductQuantityLines(lines: string[], autoDetectVlsfoRemarks: boolean) {
  const products: ProductSegment[] = []
  const consumedLineIndexes = new Set<number>()

  for (let index = 0; index < lines.length; index += 1) {
    const gradeMatch = lines[index].match(/^\s*(?:grades?|products?)\s*[:#-]?\s*(.+)$/i)
    if (!gradeMatch) continue

    const gradeSegments = gradeMatch[1]
      .split(/\s*(?:\/|;|\|)\s*/)
      .map((segment) => ({ segment, product: classifyProduct(segment) }))
      .filter((item): item is { segment: string; product: ProductSegment["product"] } => Boolean(item.product))
    if (gradeSegments.length < 2) continue

    let quantityLineIndex = -1
    let quantities: string[] = []
    for (let offset = index + 1; offset < Math.min(lines.length, index + 4); offset += 1) {
      const quantityMatch = lines[offset].match(/^\s*(?:qty|quantity|quantities)\s*[:#-]?\s*(.+)$/i)
      if (!quantityMatch) continue
      quantities = extractExplicitQuantityList(quantityMatch[1])
      quantityLineIndex = offset
      break
    }

    if (quantities.length !== gradeSegments.length || quantityLineIndex < 0) continue

    products.push(...gradeSegments.map((item, productIndex) => ({
      product: item.product,
      quantity: quantities[productIndex],
      detectedRemarks:
        item.product === "vlsfo" && autoDetectVlsfoRemarks
          ? detectVlsfoMaxRemarks(item.segment)
          : [],
    })))
    consumedLineIndexes.add(index)
    consumedLineIndexes.add(quantityLineIndex)
  }

  return { products, consumedLineIndexes }
}

function productMatches(line: string) {
  const hasExplicitVlsfo = /\b(?:v\s*l\s*s\s*f\s*o|vlsfo|vslfo|lsmfo|lsfo|l\s*s\s*(?:80|120|180|200)\s*c\s*s+\s*t)\b/i.test(line)

  return Array.from(
    line.matchAll(/(?:hsfo|hfo|ifo|r\s*\.?\s*m\s*\.?\s*k|v\s*l\s*s\s*f\s*o|vlsfo|vslfo|lsmfo|lsfo|l\s*s\s*m\s*g\s*o|lsmgo|lemgo|lsgo|mgo|mdo|dma|dmb|gas\s*oil|rmg\s*180|rmg\s*380|180\s*cst|120\s*cst|\b80\s*cst|l\s*s\s*(?:80|120|180|200)\s*c\s*s+\s*t)/gi),
  )
    .map((match) => ({
      index: match.index ?? -1,
      value: match[0],
      product: classifyProduct(match[0]),
    }))
    .filter((match): match is { index: number; value: string; product: ProductSegment["product"] } =>
      match.index >= 0 && Boolean(match.product),
    )
    .filter((match) => !(
      hasExplicitVlsfo &&
      match.product === "hsfo" &&
      /^ifo\s*\d{2,3}\s*cst\b/i.test(line.slice(match.index))
    ))
}

function extractInlineProductSegments(line: string, autoDetectVlsfoRemarks: boolean) {
  const matches = productMatches(line)
  if (matches.length < 2) return []
  if (/^\s*(?:prod(?:uct)?|grades?|spec(?:ification)?)\b\s*[:#-]?/i.test(line)) return []
  const quantityBeforeStyle = Boolean(
    extractQuantityImmediatelyBeforeProduct(line.slice(0, matches[0].index)),
  )

  return matches.flatMap((match, index) => {
    const nextMatch = matches[index + 1]
    const segmentText = line.slice(match.index, nextMatch?.index ?? line.length)
    const precedingText = line.slice(
      index === 0 ? 0 : matches[index - 1].index + matches[index - 1].value.length,
      match.index,
    )
    const precedingQuantity =
      extractQuantityImmediatelyBeforeProduct(precedingText) ||
      extractBareRangeImmediatelyBeforeProduct(precedingText) ||
      extractBareQuantityImmediatelyBeforeProduct(precedingText)
    const followingQuantity =
      extractQuantityFromInlineUnit(segmentText) ||
      extractQuantityImmediatelyAfterProduct(segmentText.slice(match.value.length)) ||
      extractBareQuantity(segmentText)
    const quantity = quantityBeforeStyle
      ? precedingQuantity || followingQuantity
      : followingQuantity || precedingQuantity
    if (!quantity) return []

    return [{
      product: match.product,
      quantity,
      detectedRemarks:
        match.product === "vlsfo"
          ? autoDetectVlsfoRemarks ? detectVlsfoMaxRemarks(segmentText) : []
          : [],
    }]
  })
}

function extractQuantityBeforeProduct(lines: string[], productIndex: number) {
  const nearby = lines.slice(Math.max(0, productIndex - 3), productIndex)
  const unitOnlyPattern = new RegExp(String.raw`^${QUANTITY_UNIT_PATTERN}$`, "i")
  for (let index = nearby.length - 1; index >= 0; index -= 1) {
    const line = nearby[index]
    if (unitOnlyPattern.test(line)) {
      const hasTableHeader = nearby
        .slice(0, Math.max(0, index - 1))
        .some((value) => /\b(?:qty|quantity|units?|grades?|iso\s*spec|sulphur|sulfur|max)\b/i.test(value))
      if (hasTableHeader) {
        const precedingQuantity = extractQuantityFromProductSegment(
          `${nearby[index - 1] || ""} ${line}`,
        )
        if (precedingQuantity) return precedingQuantity
      }
      break
    }
    if (containsProduct(line)) break
    if (/^\s*0+(?:[,.]0+)?\s*$/.test(line)) break
    const labelled = /^\s*(?:qty|quantity)\b/i.test(line)
    const standalone = /^\s*\d+(?:[,.]\d+)?(?:\s*(?:-|~|to)\s*\d+(?:[,.]\d+)?)?\s*(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?|c\s*\.?\s*b\s*\.?\s*m|k\s*\.?\s*l|[吨噸])?\s*$/i.test(line)
    if (!labelled && !standalone) continue

    const combined = nearby.slice(index).join(" ")
    const quantity = extractQuantityFromProductSegment(combined.replace(/^\s*(?:qty|quantity)\b\s*[:#-]?\s*/i, ""))
    if (quantity) return quantity
  }
  return ""
}

function stripOperationalRateClause(value: string) {
  return value.replace(
    /\b(?:(?:vsl|vessel)\s+)?(?:max(?:imum)?\s+)?(?:supply|pumping|transfer|loading|discharg(?:e|ing))\s+rate\b.*$/i,
    "",
  )
}

function extractProducts(text: string, autoDetectVlsfoRemarks: boolean) {
  const lines = normalizeInput(text)
    .split("\n")
    .map(cleanSpaces)
    .map(stripOperationalRateClause)
    .map(cleanSpaces)
    .filter(Boolean)

  const paired = extractPairedProductQuantityLines(lines, autoDetectVlsfoRemarks)
  const products: ProductSegment[] = [...paired.products]

  for (let index = 0; index < lines.length; index += 1) {
    if (paired.consumedLineIndexes.has(index)) continue
    const line = lines[index]
    if (isNonRequestProductReference(line)) continue
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
      if (isLabelLine(nextLine) && !isSulphurSpecLine(nextLine) && !/^(?:product|qty|quantity)\b/i.test(nextLine)) break

      block.push(nextLine)
      endIndex = offset

      if (new RegExp(String.raw`^${QUANTITY_UNIT_PATTERN}$`, "i").test(nextLine) || new RegExp(String.raw`${QUANTITY_UNIT_PATTERN}(?=$|[^A-Za-z0-9])`, "i").test(nextLine)) break
    }

    const quantity = extractQuantityBeforeProduct(lines, index) || extractQuantityFromBlock(block)
    if (quantity) {
      products.push({
        product,
        quantity,
          detectedRemarks:
            product === "vlsfo"
              ? autoDetectVlsfoRemarks ? detectVlsfoMaxRemarks(block.join(" ")) : []
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
  return remark.replace("cst max", "CST MAX").replace("cst min", "CST MIN")
}

export function applyVlsfoMaxRemarksToShortenedEnquiry(
  value: string,
  remarks: VlsfoMaxRemark[],
) {
  const formattedRemarks = Array.from(new Set(remarks)).map(formatVlsfoMaxRemark)

  return value
    .split(/\s*\/\s*/)
    .map((segment) => {
      const trimmed = segment.trim()
      if (!/^vlsfo\b/i.test(trimmed)) return trimmed

      const withoutRemarks = trimmed
        .replace(/\s+(?:80\s*CST\s+MIN|(?:80|120|180)\s*CST\s+MAX)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()

      return withoutRemarks.replace(
        /^vlsfo\b/i,
        ["vlsfo", ...formattedRemarks].join(" "),
      )
    })
    .filter(Boolean)
    .join(" / ")
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
  const productOrder: Record<ProductSegment["product"], number> = { hsfo: 0, vlsfo: 1, lsmgo: 2 }
  const products = extractProducts(sourceText, autoDetectVlsfoRemarks)
    .sort((first, second) => productOrder[first.product] - productOrder[second.product])
    .map((product) => formatProductSegment(product, manualVlsfoRemarks))

  return [vesselName.toLowerCase(), imo, portAndDate || date, ...Array.from(new Set(products))]
    .filter(Boolean)
    .join(" / ")
}
