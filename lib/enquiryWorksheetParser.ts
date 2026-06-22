export type EnquiryWorksheetGuess = {
  vesselName: string
  imo: string
  buyer: string
  simplifiedEnquiry: string
  confidence: "high" | "medium" | "low"
  warnings: string[]
}

type ImoCandidate = {
  value: string
  line: string
  score: number
  valid: boolean
}

const VESSEL_LABEL_PATTERN =
  /\b(?:performing\s+vessel|vessel\s*\/\s*imo|vessel|vsl|ship)\b/i

const BUYER_PATTERN =
  /^\s*buyer\s*(?:[:#\-\t]|\s{2,})?\s*([A-Za-z0-9][^\n\r,;]{1,80})/im

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
    .replace(/\u00a0/g, " ")
}

function cleanSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function stripOuterNoise(value: string) {
  return cleanSpaces(value).replace(/^[\s:;,\-./"'()]+|[\s:;,\-./"'()]+$/g, "")
}

function cleanLabeledValue(line: string) {
  return stripOuterNoise(line.replace(/^[^:]+:\s*/i, ""))
}

export function isValidImo(value: string) {
  if (!/^\d{7}$/.test(value)) return false

  const digits = value.split("").map(Number)
  const checksum = digits
    .slice(0, 6)
    .reduce((total, digit, index) => total + digit * (7 - index), 0)

  return checksum % 10 === digits[6]
}

function getCandidateLine(lines: string[], imo: string) {
  return lines.find((line) => line.includes(imo)) || ""
}

function scoreImoCandidate(candidate: string, line: string) {
  const valid = isValidImo(candidate)
  let score = valid ? 100 : -50

  if (/\bIMO(?:\s*NO\.?|\s*NUMBER)?\b/i.test(line)) score += 70
  if (VESSEL_LABEL_PATTERN.test(line)) score += 30
  if (new RegExp(`\\(\\s*${candidate}\\s*\\)`).test(line)) score += 20
  if (new RegExp(`\\/\\s*${candidate}\\s*\\/`).test(line)) score += 20
  if (/^\s*[A-Za-z0-9 .'"-]+\s*\//.test(line)) score += 10

  return { score, valid }
}

function findBestImo(lines: string[]) {
  const candidates: ImoCandidate[] = []

  for (const line of lines) {
    for (const match of line.matchAll(/\b\d{7}\b/g)) {
      const value = match[0]
      const { score, valid } = scoreImoCandidate(value, line)
      candidates.push({ value, line, score, valid })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0] || null
}

function removeVesselLabel(value: string) {
  return value.replace(
    /^\s*(?:performing\s+vessel|vessel\s*\/\s*imo|vessel|vsl|ship)\s*(?:\/\s*imo)?\s*[:#\-/]?\s*/i,
    ""
  )
}

function cleanVesselName(value: string) {
  let next = normalizeInput(value)

  next = removeVesselLabel(next)
  next = next.replace(/\bIMO(?:\s*NO\.?|\s*NUMBER)?\b[\s:#.-]*\d{0,7}.*$/i, "")
  next = next.replace(/^\s*(?:M\s*[./-]?\s*V|M\s*[./-]?\s*T|MV|MT)\b\s*/i, "")
  next = next.replace(/\(\s*(?:V|VOY|VOYAGE)\.?\s*[\w./-]+\s*\)/gi, "")
  next = next.replace(/\s*\/\/.*$/g, "")
  next = next.replace(/[“”]/g, '"')
  next = stripOuterNoise(next)

  return cleanSpaces(next).toUpperCase()
}

function isPlausibleVesselName(value: string) {
  if (!value) return false
  if (value.length < 2 || value.length > 60) return false
  if (!/[A-Z]/.test(value)) return false
  if (/^(PORT|LOCATION|ETA|ETD|DATE|PRODUCT|SPEC|QUANTITY|BUYER|AGENT)$/i.test(value)) {
    return false
  }
  return true
}

function extractVesselFromImoLine(line: string, imo: string) {
  const imoIndex = line.indexOf(imo)
  if (imoIndex < 0) return ""

  const beforeImo = line.slice(0, imoIndex)
  const cleaned = cleanVesselName(beforeImo)
  if (isPlausibleVesselName(cleaned)) return cleaned

  return ""
}

function extractLabelledVessel(lines: string[]) {
  for (const line of lines) {
    if (!VESSEL_LABEL_PATTERN.test(line)) continue

    const cleaned = cleanVesselName(line)
    if (isPlausibleVesselName(cleaned)) return cleaned
  }

  return ""
}

function extractFallbackVessel(lines: string[], imo: string) {
  if (!imo) return ""

  const line = getCandidateLine(lines, imo)
  if (!line) return ""

  const beforeImo = line.slice(0, line.indexOf(imo))
  const compactSlash = beforeImo.split("/")[0] || beforeImo
  const cleaned = cleanVesselName(compactSlash)

  return isPlausibleVesselName(cleaned) ? cleaned : ""
}

function extractBuyer(text: string) {
  const match = normalizeInput(text).match(BUYER_PATTERN)
  return match?.[1] ? stripOuterNoise(match[1]).toUpperCase() : ""
}

function extractPort(lines: string[], imo: string) {
  const labelled = lines.find((line) => /^\s*[-•]*\s*port(?:\s*\/\s*(?:location|berth))?\b/i.test(line))
  if (labelled) return cleanLabeledValue(labelled).toLowerCase()

  if (!imo) return ""
  const imoLine = getCandidateLine(lines, imo)
  if (!imoLine.includes("/")) return ""

  const parts = imoLine.split("/").map(stripOuterNoise).filter(Boolean)
  const imoPartIndex = parts.findIndex((part) => part.includes(imo))
  const possiblePort = parts[imoPartIndex + 1]
  if (!possiblePort || /\b\d{1,2}\b/.test(possiblePort)) return ""
  if (/\b(?:mt|mts|vlsfo|lsfo|mgo|hfo|ifo|rmg|dma|dmb)\b/i.test(possiblePort)) return ""

  return possiblePort.toLowerCase()
}

function normalizeDate(day: string, month: string) {
  const normalizedMonth = MONTHS[month.toLowerCase()]
  if (!normalizedMonth) return ""
  return `${Number(day)} ${normalizedMonth}`
}

function findDates(value: string) {
  const normalized = normalizeInput(value)
  const dates: string[] = []

  for (const match of normalized.matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-]\d{2,4})?\b/g)) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi)) {
    const date = normalizeDate(match[1], match[2])
    if (date) dates.push(date)
  }

  return Array.from(new Set(dates))
}

function extractDelivery(lines: string[]) {
  const labelledLines = lines.filter((line) =>
    /\b(?:delivery|window|date|eta|etd|ets)\b/i.test(line)
  )
  const dates = findDates(labelledLines.join(" ") || lines.join(" "))

  if (dates.length >= 2) return `${dates[0]} - ${dates[1]}`
  return dates[0] || ""
}

function inferProduct(text: string) {
  if (/\b(?:lsmgo|mgo|mdo|dma|dmb)\b/i.test(text)) return "mgo"
  if (/\b(?:vlsfo|lsfo|0\s*[,.]\s*5|0\s*[,.]\s*50|rmg\s*180|rmg\s*380)\b/i.test(text)) {
    return "lsfo"
  }
  if (/\b(?:hfo|hsfo|ifo|3\s*[,.]\s*5)\b/i.test(text)) return "hfo"
  return ""
}

function normalizeQuantityNumber(value: string) {
  const trimmed = value.trim()
  if (/^\d+\.0+$/.test(trimmed)) return trimmed.split(".")[0]
  return trimmed
}

function extractQuantity(text: string) {
  const normalized = normalizeInput(text)
  const range =
    normalized.match(/\b(\d{1,3}(?:[,.]\d{3})?|\d+)\s*(?:-|to)\s*(\d{1,3}(?:[,.]\d{3})?|\d+)\s*(?:m\s*t|mt|mts|tons?)\b/i) ||
    normalized.match(/\b(\d{1,3}(?:[,.]\d{3})?|\d+)\s*(?:-|to)\s*(\d{1,3}(?:[,.]\d{3})?|\d+)\b/i)

  if (range) {
    return `${normalizeQuantityNumber(range[1])}-${normalizeQuantityNumber(range[2])}mts`
  }

  const single = normalized.match(/\b(\d{1,3}(?:[,.]\d{3})?|\d+)\s*(?:m\s*t|mt|mts|tons?)\b/i)
  return single ? `${normalizeQuantityNumber(single[1])}mts` : ""
}

function buildSimplifiedEnquiry(
  text: string,
  lines: string[],
  vesselName: string,
  imo: string,
) {
  const port = extractPort(lines, imo)
  const delivery = extractDelivery(lines)
  const product = inferProduct(text)
  const quantity = extractQuantity(text)
  const portDelivery = [port, delivery].filter(Boolean).join(" ")
  const productQuantity = [product, quantity].filter(Boolean).join(" ")

  return [vesselName.toLowerCase(), imo, portDelivery, productQuantity]
    .filter(Boolean)
    .join(" / ")
}

export function parseEnquiryWorksheetGuess(text: string): EnquiryWorksheetGuess {
  const normalized = normalizeInput(text)
  const lines = normalized
    .split("\n")
    .map((line) => cleanSpaces(line))
    .filter(Boolean)

  const bestImo = findBestImo(lines)
  const imo = bestImo?.valid ? bestImo.value : ""
  const imoLine = imo ? getCandidateLine(lines, imo) : ""
  const warnings: string[] = []

  if (bestImo && !bestImo.valid) {
    warnings.push(`Found ${bestImo.value}, but it failed IMO check digit validation.`)
  }

  const vesselName =
    (imoLine ? extractVesselFromImoLine(imoLine, imo) : "") ||
    extractLabelledVessel(lines) ||
    extractFallbackVessel(lines, imo)

  if (bestImo && !imo) warnings.push("No valid IMO was found. IMO is optional.")
  if (!vesselName) warnings.push("Vessel name could not be identified with high confidence.")

  const confidence = vesselName && imo ? "high" : vesselName || imo ? "medium" : "low"

  return {
    vesselName,
    imo,
    buyer: extractBuyer(normalized),
    simplifiedEnquiry: buildSimplifiedEnquiry(normalized, lines, vesselName, imo),
    confidence,
    warnings,
  }
}
