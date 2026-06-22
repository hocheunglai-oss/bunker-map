export type EnquiryWorksheetGuess = {
  vesselName: string
  imo: string
  buyer: string
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

const BUYER_LABEL_PATTERN =
  /^\s*(?:buyer|client|for\s+account(?:\s+of)?|account(?:\s+name)?|for\s+a\/?c(?:\s+of)?|a\/?c|acct|for\s+acct(?:\s+of)?)\b\s*(?:[:#\-\t]|\s{2,})?\s*(.*)$/i

const NON_BUYER_LABEL_PATTERN =
  /^(?:address|agent|bank|berth|date|delivery|eta|etd|ets|imo|location|payment|port|product|quantity|spec|terms|vessel)\b/i

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

function stripOuterNoise(value: string) {
  return cleanSpaces(value).replace(/^[\s:;,\-./"'()]+|[\s:;,\-./"'()]+$/g, "")
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

  next = next.replace(/^\s*\d+\s*[\).:-]\s*/, "")
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
  if (/^(PORT|LOCATION|ETA|ETD|DATE|PRODUCT|SPEC|QUANTITY|BUYER|AGENT|BUNKER ONLY)$/i.test(value)) {
    return false
  }
  if (/\b(?:LSMGO|VLSFO|LSFO|MGO|HFO|IFO|RMG|DMA|DMB|MT|MTS)\b/i.test(value)) return false
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

function extractSlashPrefixVessel(lines: string[]) {
  for (const line of lines) {
    if (!line.includes("/")) continue

    const firstPart = line.split("/")[0]
    const cleaned = cleanVesselName(firstPart)
    if (isPlausibleVesselName(cleaned)) return cleaned
  }

  return ""
}

function cleanBuyerName(value: string) {
  return stripOuterNoise(value)
    .replace(/^(?:is|are)\s+/i, "")
    .replace(/\s*\/\/.*$/g, "")
    .toUpperCase()
}

function isPlausibleBuyerName(value: string) {
  if (!value) return false
  if (value.length < 2 || value.length > 100) return false
  if (!/[A-Z]/.test(value)) return false
  if (NON_BUYER_LABEL_PATTERN.test(value)) return false
  return true
}

function extractBuyer(text: string) {
  const lines = normalizeInput(text)
    .split("\n")
    .map((line) => cleanSpaces(line))
    .filter(Boolean)

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(BUYER_LABEL_PATTERN)
    if (!match) continue

    const inlineValue = cleanBuyerName(match[1] || "")
    if (isPlausibleBuyerName(inlineValue)) return inlineValue

    const nextLine = cleanBuyerName(lines[index + 1] || "")
    if (isPlausibleBuyerName(nextLine)) return nextLine
  }

  return ""
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
    extractFallbackVessel(lines, imo) ||
    extractSlashPrefixVessel(lines)

  if (bestImo && !imo) warnings.push("No valid IMO was found.")
  if (!vesselName) warnings.push("Vessel name could not be identified with high confidence.")

  const confidence = vesselName && imo ? "high" : vesselName || imo ? "medium" : "low"

  return {
    vesselName,
    imo,
    buyer: extractBuyer(normalized),
    confidence,
    warnings,
  }
}
