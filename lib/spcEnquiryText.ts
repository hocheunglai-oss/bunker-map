export type ParsedSpcEnquiry = {
  rawText: string
  title: string
  vesselName: string
  imo: string
  port: string
  deliveryWindow: string
  fuels: string
  standardText: string
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

const MONTH_PATTERN =
  /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i
const FUEL_PATTERN = /\b(vlsfo|lsfo|hsfo|ifo|mgo|lsmgo|ulsd|dma|mdo|biofuel|b24|b30|lng|mt|mts|cbm)\b/i

export function cleanSpcEnquiryText(value: string | null | undefined) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

function oneLine(value: string | null | undefined) {
  return cleanSpcEnquiryText(value).replace(/\n+/g, " / ").trim()
}

function isImoToken(value: string) {
  return /^\d{7}$/.test(value.trim())
}

function looksLikeDateWindow(value: string) {
  const text = value.trim()
  return MONTH_PATTERN.test(text) || /\b\d{1,2}\s*[-–]\s*\d{1,2}\b/.test(text)
}

function looksLikeFuel(value: string) {
  return FUEL_PATTERN.test(value.trim())
}

export function formatSpcEnquiry(input: SpcEnquiryTextInput) {
  const notes = cleanSpcEnquiryText(input.notes)
  if (notes) return notes

  const parts = [
    oneLine(input.vesselName || input.title),
    oneLine(input.port),
    oneLine(input.deliveryDate),
    oneLine([input.product, input.quantity].filter(Boolean).join(" ")),
  ].filter(Boolean)

  return parts.join(" / ")
}

export function parseSpcEnquiryText(rawValue: string): ParsedSpcEnquiry {
  const rawText = cleanSpcEnquiryText(rawValue)
  const source = oneLine(rawText)
  const parts = source
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)

  const vesselName = parts[0] || ""
  let imo = ""
  let port = ""
  let deliveryWindow = ""
  const fuels: string[] = []
  const other: string[] = []

  parts.slice(1).forEach((part) => {
    if (!imo && isImoToken(part)) {
      imo = part
      return
    }
    if (!deliveryWindow && looksLikeDateWindow(part)) {
      deliveryWindow = part
      return
    }
    if (looksLikeFuel(part)) {
      fuels.push(part)
      return
    }
    if (!port) {
      port = part
      return
    }
    other.push(part)
  })

  const fuelText = [...fuels, ...other].join(" / ")
  const standardText = [
    vesselName,
    imo,
    port,
    deliveryWindow,
    fuelText,
  ].filter(Boolean).join(" / ")
  const title = [vesselName || "New enquiry", port, deliveryWindow].filter(Boolean).join(" / ")

  return {
    rawText,
    title,
    vesselName,
    imo,
    port,
    deliveryWindow,
    fuels: fuelText,
    standardText: standardText || source,
  }
}
