import {
  findEnquiryPortInText,
  findEnquiryPortsInText,
  normalizeIndexedEnquiryPort,
} from "@/lib/enquiryPortIndex"

export type EnquiryWorksheetGuess = {
  vesselName: string
  imo: string
  port: string
  buyer: string
  confidence: "high" | "medium" | "low"
  warnings: string[]
}

export type EnquiryWorksheetParseOptions = {
  detectBuyer?: boolean
  portNames?: string[]
}

type ImoCandidate = {
  value: string
  line: string
  score: number
  valid: boolean
}

const VESSEL_LABEL_PATTERN =
  /(?:\b(?:performing\s+vessel|vessel\s*\/\s*imo|vessel(?:\s+name)?|vsl(?:\s+name)?|ship(?:\s+name)?)\b|\bname\s*\(\s*imo(?:\s*no\.?)?\s*\)|船名)/i

const VESSEL_FIELD_PATTERN =
  /^\s*['"]?\s*(?:[-•*=]\s*)?(?:\d+\s*[\).:-]\s*)?(?:performing\s+vessel|vessel\s*\/\s*imo|vessel(?:\s+name)?|vsl(?:\s+name)?|ship(?:\s+name)?|name\s*\(\s*imo(?:\s*no\.?)?\s*\)|船名)(?:\s*\(\s*imo(?:\s*no\.?|\s*number)?\s*\.?\s*\))?\s*(?:[:：#\-/\t]|\s{2,})/i

const BUYER_LABEL_PATTERN =
  /^\s*(?:\d+\s*[\).:-]\s*)?(?:buyer|client|for\s+account(?:\s+of)?|account(?:\s+name)?|for\s+a\/?c(?:\s+of)?|a\/?c|acct|for\s+acct(?:\s+of)?)\b\s*(?:[:#\-\t]|\s{2,})?\s*(.*)$/i

const NON_BUYER_LABEL_PATTERN =
  /^(?:address|agent|bank|berth|date|delivery|eta|etd|ets|imo|location|payment|port|product|quantity|spec|terms|vessel)\b/i

const PORT_LABEL_PATTERN =
  /^\s*(?:[-•*=]\s*\.?\s*)?(?:\d+\s*[\).:-]\s*)?(?:port|position|location|bunker(?:ing)?\s*(?:port|location|place)|refuell?ing\s*(?:port|location|place)|port\s+of\s+(?:call|delivery|supply)|delivery\s+(?:port|place|location)|place\s+of\s+(?:supply|delivery)|supply\s+(?:port|place|location)|loading\s+port|discharging\s+port|加油港口|港口|地点|地點)\s*(?:[:：#\-\t]|\s{2,})?\s*(.*)$/i

const NON_PORT_CONTEXT_PATTERN =
  /^\s*(?:account|agent|buyer|buyer\s+address|business\s+address|email|mail|m\/whatsapp|payment|surveyor|tel|terms)\b/i

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

  if (/\bIMO(?:\s*NO\.?|\s*NUMBER)?(?=\s|[:#.(\-]|\d|$)/i.test(line)) score += 70
  if (VESSEL_LABEL_PATTERN.test(line)) score += 30
  if (new RegExp(`\\(\\s*${candidate}\\s*\\)`).test(line)) score += 20
  if (new RegExp(`\\/\\s*${candidate}\\s*\\/`).test(line)) score += 20
  if (/^\s*[A-Za-z0-9 .'"-]+\s*\//.test(line)) score += 10

  return { score, valid }
}

function findBestImo(lines: string[]) {
  const candidates: ImoCandidate[] = []

  for (const line of lines) {
    for (const match of line.matchAll(/(?<!\d)\d{7}(?!\d)/g)) {
      const value = match[0]
      const { score, valid } = scoreImoCandidate(value, line)
      candidates.push({ value, line, score, valid })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0] || null
}

function removeVesselLabel(value: string) {
  return value
    .replace(/^\s*name\s*\(\s*imo(?:\s*no\.?)?\s*\)\s*(?:[:：#\-/]\s*)?/i, "")
    .replace(/^\s*船名(?:\s*\(\s*IMO(?:\s*NO\.?|\s*NUMBER)?\s*\.?\s*\))?\s*(?:[:：]\s*)?/i, "")
    .replace(
      /^\s*(?:performing\s+vessel|vessel\s*(?:name|\s*\/\s*imo|\(\s*imo\s*\))?|vsl(?:\s+name)?|ship(?:\s+name)?)\s*[:#\-/]?\s*/i,
      "",
    )
}

function cleanVesselName(value: string) {
  let next = normalizeInput(value)

  next = next.replace(/^\s*\[[^\]]+\]\s*[^:]{1,40}:\s*/i, "")
  next = next.replace(/^\s*\d+\s*[\).:-]\s*/, "")
  next = next.replace(/^\s*['"]?\s*[-•*=]\s*/, "")
  next = removeVesselLabel(next)
  next = next.replace(/\bIMO(?:\s*NO\.?|\s*NUMBER)?[\s:#.-]*\d{0,7}.*$/i, "")
  next = next.replace(/^\s*(?:M\s*[./-]?\s*V|M\s*[./-]?\s*T|MV|MT)\b\s*/i, "")
  next = next.replace(/^\s*(?:LPG|LNG)\s*\/?\s*C\b\s*/i, "")
  next = next.replace(/\(\s*(?:V|VOY|VOYAGE)\.?\s*[\w./-]+\s*\)/gi, "")
  next = next.replace(/\s*\/+\s*$/, "")
  next = next.replace(/\s*[-,(]\s*(?:general\s+cargo|bulk\s+carrier|oil\s+tanker|chemical\s+tanker|product\s+tanker)\s*\)?\.?\s*$/i, "")
  next = next.replace(/\s+(?:general\s+cargo|bulk\s+carrier|oil\s+tanker|chemical\s+tanker|product\s+tanker)\.?\s*$/i, "")
  next = next.replace(/\s*\/\/.*$/g, "")
  next = next.replace(/\s+(?:general\s+cargo|bulk\s+carrier|oil\s+tanker|chemical\s+tanker|product\s+tanker)\.?\s*$/i, "")
  next = next.replace(/[“”]/g, '"')
  next = stripOuterNoise(next)

  return cleanSpaces(next).toUpperCase()
}

function isPlausibleVesselName(value: string) {
  if (!value) return false
  if (value.length < 2 || value.length > 60) return false
  if (!/[A-Z]/.test(value)) return false
  if (/^(?:NAME|PORT|LOCATION|ETA|ETB|ETD|ETS|DATE|DELIVERY|PRODUCT|SPEC|QUANTITY|BUYER|AGENT|ACCOUNT|CLIENT|TERMS|PAYMENT|REMARKS|SUPPLY RESTRICTIONS|BUNKER ONLY|VOYAGE|VOY)\b/i.test(value) || /^(?:\u822a\u6b21\u53f7?|\u8239\u540d)\s*[:：]?/i.test(value)) {
    return false
  }
  if (/\b\d{1,2}\s*(?:[./-]\s*\d{1,2}|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b/i.test(value)) return false
  const compact = value.replace(/\s+/g, "")
  if (/(?:LSMGO|LEMGO|VLSFO|LSFO|MGO|HFO|IFO|RMG|DMA|DMB|MT|MTS)/i.test(compact)) return false
  return true
}

function extractVesselFromImoLine(line: string, imo: string) {
  const imoIndex = line.indexOf(imo)
  if (imoIndex < 0) return ""

  const beforeImo = line.slice(0, imoIndex)
  const quotedName = Array.from(beforeImo.matchAll(/["']([^"']{2,60})["']/g)).at(-1)?.[1] || ""
  const cleanedQuotedName = cleanVesselName(quotedName)
  if (isPlausibleVesselName(cleanedQuotedName)) return cleanedQuotedName

  const forPhrase = line.match(
    /\bfor\s+(?:the\s+)?(?:(?:m\s*[./-]?\s*v|m\s*[./-]?\s*t|mv|mt|vessel|vsl|ship)\.?\s+)?([A-Z0-9][A-Z0-9 .'"-]{1,60}?)(?=\s*(?:\(|\/)?\s*imo\b|\s+at\b|\s+eta\b|$)/i,
  )
  const cleanedForPhrase = cleanVesselName(forPhrase?.[1] || "")
  if (isPlausibleVesselName(cleanedForPhrase)) return cleanedForPhrase

  const cleaned = cleanVesselName(beforeImo)
  if (isPlausibleVesselName(cleaned)) return cleaned

  return ""
}

function extractLabelledVessel(lines: string[]) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!VESSEL_FIELD_PATTERN.test(line)) continue

    const cleaned = cleanVesselName(line)
    if (isPlausibleVesselName(cleaned)) return cleaned

    const nextLine = cleanVesselName(lines[index + 1] || "")
    if (isPlausibleVesselName(nextLine)) return nextLine
  }

  return ""
}

function extractProseVessel(lines: string[]) {
  for (const line of lines.slice(0, 10)) {
    const quoted = line.match(/\b(?:our\s+|the\s+)?vessel\s+["']([^"']{2,60})["']/i)?.[1] || ""
    const unquoted = line.match(
      /\b(?:our\s+|the\s+)?vessel\s+((?:m\s*[./-]?\s*[vt]|mv|mt)?\.?\s*[A-Z0-9][A-Z0-9 .'"-]{1,60}?)(?=\s+(?:will|is|needs?|requires?|eta|at)\b)/i,
    )?.[1] || ""
    const cleaned = cleanVesselName(quoted || unquoted)
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

function extractColonProductVessel(lines: string[]) {
  for (const line of lines.slice(0, 6)) {
    const match = line.match(
      /^\s*([A-Z0-9][A-Z0-9 .'"-]{1,60}?)\s*:\s*(?:v\s*l\s*s\s*f\s*o|vlsfo|lsfo|hsfo|hfo|ifo|l\s*s\s*m\s*g\s*o|lsmgo|lemgo|mgo|mdo|dma|dmb)\b/i,
    )
    const cleaned = cleanVesselName(match?.[1] || "")
    if (isPlausibleVesselName(cleaned)) return cleaned
  }

  return ""
}

function extractDelimitedHeaderVessel(lines: string[], options: EnquiryWorksheetParseOptions) {
  for (const line of lines.slice(0, 6)) {
    const match = line.match(/^\s*(.+?)(?:\s+(?:-|\/|\|)\s+|,\s*)(.+)$/)
    if (!match) continue

    const remainder = match[2]
    const hasTradingDetails = Boolean(
      findKnownPort(remainder, { ...options, includeShortAliases: true }) ||
      /\b(?:eta|etb|etd|ets|vlsfo|lsfo|hsfo|hfo|ifo|lsmgo|mgo|\d{1,2}(?:st|nd|rd|th)?[.\s/-]*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec))\b/i.test(remainder),
    )
    if (!hasTradingDetails) continue

    const cleaned = cleanVesselName(match[1])
    if (isPlausibleVesselName(cleaned)) return cleaned
  }

  return ""
}

function extractLeadingVesselBeforeTradingDetails(lines: string[]) {
  for (const line of lines.slice(0, 6)) {
    if (/^\s*(?:account|agent|buyer|date|eta|port|position|product|quantity)\b/i.test(line)) continue

    const match = line.match(
      /^\s*(?:m\s*[./-]?\s*v|m\s*[./-]?\s*t|mv|mt)?\.?\s*([A-Z0-9][A-Z0-9 .'"-]{1,60}?)(?=\s*(?:[,，]\s*)?(?:@|at\s+|eta\b|etb\b|etd\b|ets\b|v\s*l\s*s\s*f\s*o|vlsfo|lsfo|hsfo|hfo|ifo|l\s*s\s*m\s*g\s*o|lsmgo|lemgo|mgo|\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)))\b/i,
    )
    const cleaned = cleanVesselName(match?.[1] || "")
    if (isPlausibleVesselName(cleaned)) return cleaned
  }

  return ""
}

function extractLeadingVesselBeforeChineseSchedule(lines: string[]) {
  for (const line of lines.slice(0, 6)) {
    const match = line.match(
      /^\s*(?:m\s*[./-]?\s*v|m\s*[./-]?\s*t|mv|mt)?\.?\s*([A-Z][A-Z0-9 .'"-]{1,60}?)\s+(?=\d{1,2}\s*(?:-|~|\u81f3|\u5230)\s*\d{1,2}\s*[\u65e5\u53f7]|\u5230\u8fbe|\u62b5\u8fbe)/i,
    )
    const cleaned = cleanVesselName(match?.[1] || "")
    if (isPlausibleVesselName(cleaned)) return cleaned
  }

  return ""
}

function extractHeaderVessel(lines: string[]) {
  for (const line of lines.slice(0, 4)) {
    if (/^\s*(?:good\s+day|dear|hi|hello|please|kindly|quote|re\b|subject\b)/i.test(line)) continue
    const hasLocationMarker = /\s+@\s+/.test(line)
    const hasShipPrefix = /^\s*(?:m\s*[./-]?\s*v|m\s*[./-]?\s*t|mv|mt)\b/i.test(line)
    const mostlyCaps = line === line.toUpperCase() && /[A-Z]{2}/.test(line)
    if (!hasLocationMarker && !hasShipPrefix && !mostlyCaps) continue

    const beforeLocation = line.split(/\s+@\s+/)[0] || line
    const cleaned = cleanVesselName(beforeLocation)
    if (isPlausibleVesselName(cleaned)) return cleaned
  }

  return ""
}

function findKnownPort(
  value: string,
  options: EnquiryWorksheetParseOptions & { includeShortAliases?: boolean } = {},
) {
  return findEnquiryPortInText(normalizeInput(value), {
    portNames: options.portNames,
    includeShortAliases: options.includeShortAliases,
  })
}

function cleanPortName(
  value: string,
  options: EnquiryWorksheetParseOptions & { allowUnknown?: boolean; includeShortAliases?: boolean } = {},
) {
  let next = normalizeInput(value)

  const indexedInline = findEnquiryPortInText(next, {
    portNames: options.portNames,
    includeShortAliases: options.includeShortAliases,
  })
  if (indexedInline) return indexedInline

  next = next.replace(/^\s*(?:[-•*=]\s*\.?\s*)?(?:or\s+)?(?:port|position|location|bunker(?:ing)?\s*(?:port|location|place)|加油港口|港口)\s*[:：#\-\t]?\s*/i, "")
  next = next.replace(/\([^)]*\)/g, " ")
  next = next.replace(/\b(?:bunkers?\s+only|bunker(?:ing)?|call|berth|discharging|loading|unloading)\b.*$/i, "")
  next = next.replace(/\b(?:eta|etb|etd|ets|wp\/agw|iagw)\b.*$/i, "")
  next = next.split(/\s+:\s+/)[0] || next
  next = next.split(/[,，]/)[0] || next
  next = stripOuterNoise(next)

  const indexedExact = normalizeIndexedEnquiryPort(next, {
    portNames: options.portNames,
    includeShortAliases: options.includeShortAliases,
  })
  if (indexedExact) return indexedExact

  const known = findKnownPort(next, options)
  if (known) return known

  if (!options.allowUnknown) return ""

  if (!/^[A-Za-z][A-Za-z\s.'-]{1,36}$/.test(next)) return ""
  if (/\b(?:days?|delivery|january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|mt|mts|ton)\b/i.test(next)) {
    return ""
  }

  return next.toLowerCase()
}

function extractStructuredSlashPort(
  lines: string[],
  options: EnquiryWorksheetParseOptions,
) {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const structuredLine = line.replace(/^\s*\[[^\]]+\]\s*[^:]{1,40}:\s*/i, "")
    const parts = structuredLine.split("/").map(cleanSpaces).filter(Boolean)
    if (parts.length < 2) continue

    const firstPart = parts[0]
    const hasVesselIdentity = /(?<!\d)\d{7}(?!\d)/.test(firstPart) ||
      isPlausibleVesselName(cleanVesselName(firstPart))
    const tradingText = [parts.slice(1).join(" / "), ...lines.slice(lineIndex + 1)].join("\n")
    const hasTradingDetails = /\b(?:eta|etb|etd|ets|vlsfo|lsfo|hsfo|hfo|ifo|lsmgo|mgo|mt|mts|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(tradingText) ||
      /\b\d{1,2}\s*(?:-|~|to)?\s*\d{0,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(tradingText)
    if (!hasVesselIdentity || !hasTradingDetails) continue

    for (const part of parts.slice(1)) {
      const port = findKnownPort(part, { ...options, includeShortAliases: true })
      if (port) return port
    }
  }

  return ""
}

export function extractEnquiryPort(text: string, options: EnquiryWorksheetParseOptions = {}) {
  const lines = normalizeInput(text)
    .split("\n")
    .map((line) => cleanSpaces(line))
    .filter(Boolean)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(PORT_LABEL_PATTERN)
    if (!match) continue

    const labelledValue = match[1] || ""
    const alternatives = findEnquiryPortsInText(labelledValue, {
      portNames: options.portNames,
      includeShortAliases: true,
    })
    if (/\bor\b/i.test(labelledValue) && alternatives.length > 1) {
      return alternatives.slice(0, 2).join(" or ")
    }

    const inlinePort = cleanPortName(labelledValue, {
      ...options,
      allowUnknown: true,
      includeShortAliases: true,
    })
    if (inlinePort) return inlinePort

    const nextPort = cleanPortName(lines[index + 1] || "", {
      ...options,
      allowUnknown: true,
      includeShortAliases: true,
    })
    if (nextPort) return nextPort
  }

  const structuredSlashPort = extractStructuredSlashPort(lines, options)
  if (structuredSlashPort) return structuredSlashPort

  for (const line of lines) {
    if (NON_PORT_CONTEXT_PATTERN.test(line) || /[\w.-]+@[\w.-]+/.test(line)) continue

    const etaSuffix = line.split(/\b(?:eta|etb|etd|ets)\b/i)[1] || ""
    const etaPort = findKnownPort(etaSuffix, { ...options, includeShortAliases: true })
    if (etaPort) return etaPort

    const standalonePort = normalizeIndexedEnquiryPort(stripOuterNoise(line), {
      portNames: options.portNames,
      includeShortAliases: true,
    })
    if (standalonePort) return standalonePort

    const atMatch = line.match(/@\s*([A-Za-z][A-Za-z\s.'-]{1,36})\b/)
    const atPort = cleanPortName(atMatch?.[1] || "", {
      ...options,
      includeShortAliases: true,
    })
    if (atPort) return atPort

    const contextualMatch = line.match(/\b(?:at|in|calling|position(?:ed)?|bunkering\s+at)\s+([A-Za-z][A-Za-z\s.'-]{1,36})\b/i)
    const contextualPort = cleanPortName(contextualMatch?.[1] || "", {
      ...options,
      includeShortAliases: true,
    })
    if (contextualPort) return contextualPort

    if (/\b(?:bunkers?|eta|etb|etd|ets|vlsfo|lsfo|hsfo|hfo|ifo|lsmgo|mgo|january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(line) || /\b\d{1,2}(?:[./-]\d{1,2}|st|nd|rd|th)\b/i.test(line) || /\b\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(line) || /[月日号월일]|到达|抵达/.test(line)) {
      const known = findKnownPort(line, { ...options, includeShortAliases: true })
      if (known) return known
    }
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
  if (/^(?:BUYER|CLIENT|ACCOUNT|ACCT|A\/C)$/i.test(value)) return false
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

export function parseEnquiryWorksheetGuess(
  text: string,
  options: EnquiryWorksheetParseOptions = {},
): EnquiryWorksheetGuess {
  const detectBuyer = options.detectBuyer !== false
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
    extractProseVessel(lines) ||
    extractFallbackVessel(lines, imo) ||
    extractColonProductVessel(lines) ||
    extractDelimitedHeaderVessel(lines, options) ||
    extractLeadingVesselBeforeTradingDetails(lines) ||
    extractLeadingVesselBeforeChineseSchedule(lines) ||
    extractHeaderVessel(lines) ||
    extractSlashPrefixVessel(lines)

  if (bestImo && !imo) warnings.push("No valid IMO was found.")
  if (!vesselName) warnings.push("Vessel name could not be identified with high confidence.")

  const confidence = vesselName && imo ? "high" : vesselName || imo ? "medium" : "low"

  return {
    vesselName,
    imo,
    port: extractEnquiryPort(normalized, options),
    buyer: detectBuyer ? extractBuyer(normalized) : "",
    confidence,
    warnings,
  }
}
