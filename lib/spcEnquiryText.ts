import {
  buildShortenedEnquiry,
  detectVlsfoMaxRemarks,
  findEnquiryDates,
  formatVlsfoMaxRemark,
  normalizeEnquiryQuantityNumber,
  replaceHsfoWithRmk,
  type VlsfoMaxRemark,
} from "@/lib/enquiryShortener"
import { isValidImo, parseEnquiryWorksheetGuess } from "@/lib/enquiryWorksheetParser"

export type ParsedSpcEnquiry = {
  rawText: string
  title: string
  vesselName: string
  imo: string
  eta: string
  hsfo: string
  vlsfo: string
  lsmgo: string
  remarks: string
  standardText: string
}

export type SpcEnquiryMeta = {
  imo?: string
  lostReason?: string
  stemSupplierTraderUsername?: string
  stemSupplierTraderDisplayName?: string
  outcomeAt?: string
  postponedAt?: string
  cancelledAt?: string
  fixtureSupplier?: string
  eta?: string
  hsfo?: string
  vlsfo?: string
  lsmgo?: string
  price?: string
  barging?: string
}

export type SpcEnquiryTextInput = {
  title?: string | null
  vesselName?: string | null
  port?: string | null
  product?: string | null
  quantity?: string | null
  deliveryDate?: string | null
  supplierName?: string | null
  notes?: string | null
  enquiryNumber?: string | null
}

export type StoredSpcEnquiryFieldsInput = {
  formattedText?: string | null
  title?: string | null
  vesselName?: string | null
  meta?: SpcEnquiryMeta | null
}

const SPC_META_MARKER = "---SPC_META---"
const MONTH_PATTERN =
  /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i
const FUEL_PATTERN = /(v\s*l\s*s\s*f\s*o|vlsfo|vslfo|lsmfo|lsfo|l\s*s\s*(?:80|120|180|200)\s*c\s*s+\s*t|hsfo|hfo|ifo|rmk|mgo|gas\s*oil|fuel\s*oil|l\s*s\s*m\s*g\s*o|lsmgo|lemgo|lsgo|ulsd|dma|mdo|biofuel|b24|b30|lng|mt|mts|cbm|rmg|180\s*cst|120\s*cst)/i
const RMK_PRODUCT_PATTERN = /\br\s*\.?\s*m\s*\.?\s*k\s*\.?s?\b/i
const META_KEYS: Array<keyof SpcEnquiryMeta> = [
  "imo",
  "lostReason",
  "stemSupplierTraderUsername",
  "stemSupplierTraderDisplayName",
  "outcomeAt",
  "postponedAt",
  "cancelledAt",
  "fixtureSupplier",
  "eta",
  "hsfo",
  "vlsfo",
  "lsmgo",
  "price",
  "barging",
]

export function cleanSpcEnquiryText(value: string | null | undefined) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[：]/g, ":")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

export function splitSpcEnquiryNotes(value: string | null | undefined) {
  const raw = String(value || "")
  const markerIndex = raw.indexOf(SPC_META_MARKER)
  if (markerIndex < 0) {
    return { text: raw, metaText: "" }
  }

  return {
    text: raw.slice(0, markerIndex),
    metaText: raw.slice(markerIndex + SPC_META_MARKER.length),
  }
}

function cleanMetaValue(value: unknown) {
  if (typeof value !== "string") return undefined
  const cleaned = value.trim()
  return cleaned || undefined
}

export function readSpcEnquiryMeta(value: string | null | undefined): SpcEnquiryMeta {
  const { metaText } = splitSpcEnquiryNotes(value)
  const source = metaText.trim()
  if (!source) return {}

  try {
    const parsed = JSON.parse(source) as Record<string, unknown>
    return META_KEYS.reduce<SpcEnquiryMeta>((meta, key) => {
      const cleaned = cleanMetaValue(parsed[key])
      if (cleaned) meta[key] = cleaned
      return meta
    }, {})
  } catch {
    return {}
  }
}

export function cleanSpcEnquiryMeta(meta: SpcEnquiryMeta) {
  return META_KEYS.reduce<SpcEnquiryMeta>((cleaned, key) => {
    const value = cleanMetaValue(meta[key])
    if (value) cleaned[key] = value
    return cleaned
  }, {})
}

export function writeSpcEnquiryNotes(text: string | null | undefined, meta: SpcEnquiryMeta) {
  const baseText = cleanSpcEnquiryText(splitSpcEnquiryNotes(text).text)
  const cleanedMeta = cleanSpcEnquiryMeta(meta)
  if (Object.keys(cleanedMeta).length === 0) return baseText
  return `${baseText}\n\n${SPC_META_MARKER}\n${JSON.stringify(cleanedMeta)}`
}

function oneLine(value: string | null | undefined) {
  return cleanSpcEnquiryText(value).replace(/\n+/g, " / ").trim()
}

function lowerText(value: string | null | undefined) {
  return oneLine(value)
    .replace(/[–—]/g, "-")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function isImoToken(value: string) {
  return isValidImo(value.trim())
}

function looksLikeDateWindow(value: string) {
  const text = value.trim()
  if (MONTH_PATTERN.test(text)) return findEnquiryDates(text).length > 0

  const bareRange = text.match(/^(?:sg\s+)?(\d{1,2})\s*[-–]\s*(\d{1,2})$/i)
  return Boolean(
    bareRange &&
    Number(bareRange[1]) >= 1 &&
    Number(bareRange[1]) <= 31 &&
    Number(bareRange[2]) >= 1 &&
    Number(bareRange[2]) <= 31,
  )
}

function looksLikeFuel(value: string) {
  return FUEL_PATTERN.test(value.trim())
}

export type SpcFuelKey = "hsfo" | "vlsfo" | "lsmgo"

export type ExplicitSpcFuelFields = Partial<Record<SpcFuelKey, string>>

function classifyFuel(value: string): SpcFuelKey | "" {
  const compact = value.toLowerCase().replace(/\s+/g, "")
  if (/(?:lsmgo|lemgo|lsgo|mgo|mdo|dma|dmb|gasoil)/i.test(compact)) return "lsmgo"
  if (/(?:vlsfo|vslfo|lsmfo|lsfo|ls(?:80|120|180|200)cst|rmg180|180cst|120cst)/i.test(compact) || /(?:^|[^0-9])0\s*[,.]\s*5(?:0)?(?=$|[^0-9])/i.test(value)) {
    return "vlsfo"
  }
  if (/\b(?:hsfo|hfo|ifo|rmk)(?:\s*\d{2,3})?\b/i.test(value) || /(?:^|[^0-9])s?\s*3\s*[,.]\s*5(?:0)?(?=$|[^0-9])/i.test(value)) {
    return "hsfo"
  }
  return ""
}

function extractQuantity(value: string) {
  const unit = String.raw`(?:m\s*\.?\s*tons?|m\s*t|mt|mts|tons?|c\s*\.?\s*b\s*\.?\s*m|k\s*\.?\s*l|[吨噸])`
  const range = value.match(new RegExp(String.raw`\b(\d+(?:[,.]\d+)?)\s*(?:-|to)\s*(\d+(?:[,.]\d+)?)\s*${unit}(?=$|[^A-Za-z0-9])`, "i"))
  if (range) {
    return `${normalizeEnquiryQuantityNumber(range[1])}-${normalizeEnquiryQuantityNumber(range[2])}mts`
  }

  const matches = Array.from(value.matchAll(new RegExp(String.raw`\b(\d+(?:[,.]\d+)?)\s*${unit}(?=$|[^A-Za-z0-9])`, "gi")))
    .map((match) => match[1])
  const quantity = matches.at(-1)
  return quantity ? `${normalizeEnquiryQuantityNumber(quantity)}mts` : ""
}

export function extractExplicitSpcFuelFields(rawValue: string): ExplicitSpcFuelFields {
  const fields: ExplicitSpcFuelFields = {}
  const lines = cleanSpcEnquiryText(rawValue).split("\n")

  for (const line of lines) {
    const match = line.match(
      /^\s*(?:[-*]\s*)?(v\s*l\s*s\s*f\s*o|vlsfo|vslfo|lsmfo|lsfo|l\s*s\s*(?:80|120|180|200)\s*c\s*s+\s*t|hsfo|hfo|ifo|rmk|fuel\s*oil|gas\s*oil|l\s*s\s*m\s*g\s*o|lsmgo|lemgo|lsgo|mgo|mdo|dma|dmb)(?:\s*[:=-]\s*|\s+)(.+)$/i,
    )
    if (!match) continue

    const fuel = classifyFuel(line)
    const quantity = extractQuantity(match[2])
    if (fuel && quantity) fields[fuel] = quantity
  }

  return fields
}

function vlsfoRemarks(value: string) {
  const remarks: string[] = []
  if (/\b180\s*cst\b/i.test(value)) remarks.push("180cst max")
  if (/\b120\s*cst\b/i.test(value)) remarks.push("120cst max")
  return remarks
}

function mergeVlsfoMaxRemarks(...remarkGroups: VlsfoMaxRemark[][]) {
  return Array.from(new Set(remarkGroups.flat()))
}

function stripVlsfoMaxRemarks(value: string) {
  return value
    .replace(/\b80\s*cst\s*max\b/gi, "")
    .replace(/\b180\s*cst\s*max\b/gi, "")
    .replace(/\b120\s*cst\s*max\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function cleanSpcFuelValue(value: string | null | undefined, fuel: SpcFuelKey) {
  let text = lowerText(value)
  if (!text) return ""

  text = text
    .replace(/[()]/g, " ")
    .replace(/\bmax(?:imum)?\b/gi, "max")
    .replace(/\bvisc(?:osity)?\b/gi, "visc")
    .replace(/\s+/g, " ")
    .trim()

  if (fuel === "hsfo") text = text.replace(/^\s*(?:hsfo|hfo|ifo|rmk|rmg\s*380|3\s*[,.]\s*5)(?=\s|[:/-]|\d|$)\s*[:/-]?\s*/i, "")
  if (fuel === "vlsfo") text = text.replace(/^\s*(?:v\s*l\s*s\s*f\s*o|vlsfo|lsmfo|lsfo|0\s*[,.]\s*5|0\s*[,.]\s*50|rmg\s*180)(?=\s|[:/-]|\d|$)\s*[:/-]?\s*/i, "")
  if (fuel === "lsmgo") text = text.replace(/^\s*(?:l\s*s\s*m\s*g\s*o|lsmgo|lemgo|lsgo|mgo|mdo|dma|dmb)(?=\s|[:/-]|\d|$)\s*[:/-]?\s*/i, "")

  const plainNumber = text.match(/^(\d+(?:[,.]\d+)?)$/)
  if (plainNumber) return `${normalizeEnquiryQuantityNumber(plainNumber[1])}mts`
  const plainRange = text.match(/^(\d+(?:[,.]\d+)?)\s*(?:-|to)\s*(\d+(?:[,.]\d+)?)$/)
  if (plainRange) {
    return `${normalizeEnquiryQuantityNumber(plainRange[1])}-${normalizeEnquiryQuantityNumber(plainRange[2])}mts`
  }

  const quantity = extractQuantity(text)
  const remarks = fuel === "vlsfo" ? vlsfoRemarks(text) : []
  if (quantity) return [...remarks, quantity].join(" ")
  return text
}

export function spcFuelInputValue(value: string | null | undefined, fuel: SpcFuelKey) {
  const cleaned = cleanSpcFuelValue(value, fuel)
  const quantity = cleaned.match(/(\d+(?:[,.]\d+)?(?:\s*-\s*\d+(?:[,.]\d+)?)?)mts$/i)?.[1] || ""
  return quantity.replace(/\s+/g, "").replace(/,/g, "")
}

export function formatSpcFuelSegment(
  fuel: SpcFuelKey,
  value: string | null | undefined,
  manualVlsfoRemarks: VlsfoMaxRemark[] = [],
) {
  const cleaned = cleanSpcFuelValue(value, fuel)
  if (!cleaned) return ""
  if (fuel === "hsfo") return `HSFO ${cleaned}`
  if (fuel === "lsmgo") return `lsmgo ${cleaned}`

  const remarks = mergeVlsfoMaxRemarks(detectVlsfoMaxRemarks(cleaned), manualVlsfoRemarks)
  const quantity = stripVlsfoMaxRemarks(cleaned)
  return ["vlsfo", ...remarks.map(formatVlsfoMaxRemark), quantity].filter(Boolean).join(" ")
}

export function buildSpcStandardEnquiry(input: {
  vesselName?: string | null
  imo?: string | null
  eta?: string | null
  hsfo?: string | null
  vlsfo?: string | null
  lsmgo?: string | null
  remarks?: string | null
  vlsfoMaxRemarks?: VlsfoMaxRemark[]
}) {
  return [
    lowerText(input.vesselName),
    lowerText(input.imo),
    lowerText(input.eta),
    formatSpcFuelSegment("hsfo", input.hsfo),
    formatSpcFuelSegment("vlsfo", input.vlsfo, input.vlsfoMaxRemarks || []),
    formatSpcFuelSegment("lsmgo", input.lsmgo),
    lowerText(input.remarks),
  ].filter(Boolean).join(" / ")
}

export function ensureSpcSingaporeEta(value: string | null | undefined) {
  const eta = lowerText(value)
  if (!eta || !/\d/.test(eta)) return eta

  const withoutSingapore = eta
    .replace(/^(?:singapore\b\s*|(?:sgp|sin|sg)(?=\s*\d)\s*|新加坡\s*)/i, "")
    .trim()
  return withoutSingapore ? `sg ${withoutSingapore}` : ""
}

export function formatSpcEnquiry(input: SpcEnquiryTextInput) {
  const notes = cleanSpcEnquiryText(splitSpcEnquiryNotes(input.notes).text)
  if (notes) return notes

  const parts = [
    oneLine(input.vesselName || input.title),
    oneLine(input.port),
    oneLine(input.deliveryDate),
    oneLine([input.product, input.quantity].filter(Boolean).join(" ")),
  ].filter(Boolean)

  return parts.join(" / ")
}

function parseDelimitedSpcEnquiryText(rawValue: string, manualVlsfoRemarks: VlsfoMaxRemark[] = []): ParsedSpcEnquiry {
  const rawText = cleanSpcEnquiryText(rawValue)
  const source = oneLine(rawText)
  const parts = source
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)

  const vesselName = parts[0] || ""
  let imo = ""
  let eta = ""
  let hsfo = ""
  let vlsfo = ""
  let lsmgo = ""
  const remarks: string[] = []
  let seenTradingDetail = false

  parts.slice(1).forEach((part) => {
    if (!imo && isImoToken(part)) {
      imo = part
      return
    }
    if (!eta && looksLikeDateWindow(part)) {
      eta = lowerText(part)
      seenTradingDetail = true
      return
    }
    if (looksLikeFuel(part)) {
      const fuel = classifyFuel(part)
      if (fuel === "hsfo") hsfo = cleanSpcFuelValue(part, "hsfo")
      else if (fuel === "vlsfo") vlsfo = cleanSpcFuelValue(part, "vlsfo")
      else if (fuel === "lsmgo") lsmgo = cleanSpcFuelValue(part, "lsmgo")
      else remarks.push(lowerText(part))
      seenTradingDetail = true
      return
    }
    if (seenTradingDetail) remarks.push(lowerText(part))
  })

  const builtStandardText = buildSpcStandardEnquiry({
    vesselName,
    imo,
    eta,
    hsfo,
    vlsfo,
    lsmgo,
    remarks: remarks.join(" / "),
    vlsfoMaxRemarks: manualVlsfoRemarks,
  })
  const title = [lowerText(vesselName) || "new enquiry", eta].filter(Boolean).join(" / ")

  const standardText = RMK_PRODUCT_PATTERN.test(rawText)
    ? replaceHsfoWithRmk(builtStandardText)
    : builtStandardText

  return {
    rawText,
    title,
    vesselName: lowerText(vesselName),
    imo,
    eta,
    hsfo,
    vlsfo,
    lsmgo,
    remarks: remarks.join(" / "),
    standardText: standardText || lowerText(source),
  }
}

export function parseSpcEnquiryText(
  rawValue: string,
  manualVlsfoRemarks: VlsfoMaxRemark[] = [],
): ParsedSpcEnquiry {
  const rawText = cleanSpcEnquiryText(rawValue)
  if (!rawText) {
    return {
      rawText: "",
      title: "",
      vesselName: "",
      imo: "",
      eta: "",
      hsfo: "",
      vlsfo: "",
      lsmgo: "",
      remarks: "",
      standardText: "",
    }
  }

  const delimited = parseDelimitedSpcEnquiryText(rawText, manualVlsfoRemarks)
  const guess = parseEnquiryWorksheetGuess(rawText, { detectBuyer: false })
  const vesselName = lowerText(guess.vesselName || delimited.vesselName)
  const imo = guess.imo || delimited.imo
  const isSingaporeEnquiry = guess.port.trim().toLowerCase() === "singapore" ||
    /(?:^|[^a-z0-9])(?:sgp|sin|sg)(?=\s*\d{1,2})/i.test(rawText)
  const shortened = buildShortenedEnquiry(
    rawText,
    guess.vesselName || delimited.vesselName,
    imo,
    manualVlsfoRemarks,
    { autoDetectVlsfoRemarks: false, includePort: false },
  )
  const shortenedParts = shortened ? parseDelimitedSpcEnquiryText(shortened, manualVlsfoRemarks) : null
  const parsedEta = shortenedParts?.eta || delimited.eta
  const eta = isSingaporeEnquiry ? ensureSpcSingaporeEta(parsedEta) : parsedEta
  const hsfo = shortenedParts?.hsfo || delimited.hsfo
  const vlsfo = shortenedParts?.vlsfo || delimited.vlsfo
  const lsmgo = shortenedParts?.lsmgo || delimited.lsmgo
  const remarks = ""
  const builtStandardText = buildSpcStandardEnquiry({
    vesselName,
    imo,
    eta,
    hsfo,
    vlsfo,
    lsmgo,
    remarks,
    vlsfoMaxRemarks: manualVlsfoRemarks,
  })

  const standardText = RMK_PRODUCT_PATTERN.test(rawText)
    ? replaceHsfoWithRmk(builtStandardText)
    : builtStandardText

  return {
    rawText,
    title: [vesselName || "new enquiry", eta].filter(Boolean).join(" / "),
    vesselName,
    imo,
    eta,
    hsfo,
    vlsfo,
    lsmgo,
    remarks,
    standardText: standardText || delimited.standardText || lowerText(rawText),
  }
}

export function restoreStoredSpcEnquiryFields(input: StoredSpcEnquiryFieldsInput) {
  const parsed = parseSpcEnquiryText(input.formattedText || input.title || "")
  const meta = input.meta || {}
  return {
    ...parsed,
    vesselName: lowerText(input.vesselName || parsed.vesselName),
    imo: cleanMetaValue(meta.imo) || parsed.imo,
    eta: cleanMetaValue(meta.eta) || parsed.eta,
    hsfo: cleanMetaValue(meta.hsfo) || parsed.hsfo,
    vlsfo: cleanMetaValue(meta.vlsfo) || parsed.vlsfo,
    lsmgo: cleanMetaValue(meta.lsmgo) || parsed.lsmgo,
  }
}
