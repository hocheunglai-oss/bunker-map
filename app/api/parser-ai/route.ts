import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import {
  buildShortenedEnquiry,
  detectVlsfoMaxRemarks,
  type VlsfoMaxRemark,
} from "@/lib/enquiryShortener"
import {
  extractEnquiryPort,
  isValidImo,
  parseEnquiryWorksheetGuess,
} from "@/lib/enquiryWorksheetParser"
import {
  buildSpcStandardEnquiry,
  cleanSpcEnquiryText,
  parseSpcEnquiryText,
} from "@/lib/spcEnquiryText"
import { requireSpcPagePermission } from "@/lib/spcAuth"

export const maxDuration = 60

const MAX_TEXT_LENGTH = 20_000
const MODEL = "gpt-5.4-mini"

type ParserAiSource = "enquiryworksheet" | "spc"

type ParserAiPayload = {
  source?: unknown
  context?: unknown
  rawText?: unknown
  cleanedText?: unknown
  parserOutput?: unknown
  currentOutput?: unknown
  fields?: unknown
  manualVlsfoMaxRemarks?: unknown
}

type ParserAiDraft = {
  correctedOutput: string
  vesselName: string
  imo: string
  port: string
  buyer: string
  eta: string
  hsfo: string
  vlsfo: string
  lsmgo: string
  remarks: string
  vlsfoMaxRemarks: VlsfoMaxRemark[]
  confidence: number
  warnings: string[]
}

type ParserImoLookupDraft = {
  imo: string
  confidence: number
  warning: string
}

type ParserAiSourceLink = {
  title: string
  url: string
}

class HttpError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const PARSER_AI_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    correctedOutput: { type: "string" },
    vesselName: { type: "string" },
    imo: { type: "string" },
    port: { type: "string" },
    buyer: { type: "string" },
    eta: { type: "string" },
    hsfo: { type: "string" },
    vlsfo: { type: "string" },
    lsmgo: { type: "string" },
    remarks: { type: "string" },
    vlsfoMaxRemarks: {
      type: "array",
      items: { type: "string", enum: ["180cst max", "120cst max"] },
    },
    confidence: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "correctedOutput",
    "vesselName",
    "imo",
    "port",
    "buyer",
    "eta",
    "hsfo",
    "vlsfo",
    "lsmgo",
    "remarks",
    "vlsfoMaxRemarks",
    "confidence",
    "warnings",
  ],
} as const

const PARSER_IMO_LOOKUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    imo: { type: "string" },
    confidence: { type: "number" },
    warning: { type: "string" },
  },
  required: ["imo", "confidence", "warning"],
} as const

function asString(value: unknown, maxLength = MAX_TEXT_LENGTH) {
  return String(typeof value === "string" ? value : "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength)
}

function sourceFrom(value: unknown): ParserAiSource | null {
  return value === "enquiryworksheet" || value === "spc" ? value : null
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function cleanMultiline(value: unknown) {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").trim()
    : ""
}

function cleanImo(value: unknown) {
  const imo = cleanText(value).replace(/\D/g, "").slice(0, 7)
  return isValidImo(imo) ? imo : ""
}

function cleanConfidence(value: unknown) {
  const confidence = typeof value === "number" && Number.isFinite(value) ? value : 0.5
  return Math.min(1, Math.max(0, confidence))
}

function cleanWarnings(value: unknown) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean).slice(0, 8) : []
}

function uniqueWarnings(warnings: string[]) {
  return Array.from(new Set(warnings.map(cleanText).filter(Boolean))).slice(0, 8)
}

function cleanVlsfoMaxRemarks(value: unknown): VlsfoMaxRemark[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value.filter((item): item is VlsfoMaxRemark =>
        item === "180cst max" || item === "120cst max",
      ),
    ),
  )
}

function extractOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const source = payload as Record<string, unknown>
  if (typeof source.output_text === "string") return source.output_text

  const output = Array.isArray(source.output) ? source.output : []
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== "object") continue
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const text = (part as Record<string, unknown>).text
      if (typeof text === "string") chunks.push(text)
    }
  }
  return chunks.join("\n").trim()
}

function addSourceLink(links: ParserAiSourceLink[], value: unknown) {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  const nested = record.url_citation && typeof record.url_citation === "object"
    ? record.url_citation as Record<string, unknown>
    : record
  const url = cleanText(nested.url)
  if (!url || links.some((link) => link.url === url)) return
  links.push({
    title: cleanText(nested.title) || url,
    url,
  })
}

function extractWebSourceLinks(payload: unknown): ParserAiSourceLink[] {
  if (!payload || typeof payload !== "object") return []
  const output = Array.isArray((payload as Record<string, unknown>).output)
    ? (payload as Record<string, unknown>).output as unknown[]
    : []
  const links: ParserAiSourceLink[] = []

  for (const item of output) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const content = Array.isArray(record.content) ? record.content : []
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const annotations = Array.isArray((part as Record<string, unknown>).annotations)
        ? (part as Record<string, unknown>).annotations as unknown[]
        : []
      annotations.forEach((annotation) => addSourceLink(links, annotation))
    }

    const action = record.action && typeof record.action === "object"
      ? record.action as Record<string, unknown>
      : {}
    const sources = Array.isArray(action.sources) ? action.sources : []
    sources.forEach((source) => addSourceLink(links, source))
  }

  return links.slice(0, 3)
}

function getAiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback
  const error = (payload as Record<string, unknown>).error
  if (error && typeof error === "object") {
    const message = cleanText((error as Record<string, unknown>).message)
    if (message) return message
  }
  return fallback
}

function normalizeDraft(value: unknown): ParserAiDraft {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const vlsfoMaxRemarks = cleanVlsfoMaxRemarks(source.vlsfoMaxRemarks)
  const correctedOutput = cleanMultiline(source.correctedOutput)

  return {
    correctedOutput,
    vesselName: cleanText(source.vesselName),
    imo: cleanImo(source.imo),
    port: cleanText(source.port).toLowerCase(),
    buyer: cleanText(source.buyer).toUpperCase(),
    eta: cleanText(source.eta).toLowerCase(),
    hsfo: cleanText(source.hsfo),
    vlsfo: cleanText(source.vlsfo),
    lsmgo: cleanText(source.lsmgo),
    remarks: cleanText(source.remarks).toLowerCase(),
    vlsfoMaxRemarks,
    confidence: cleanConfidence(source.confidence),
    warnings: cleanWarnings(source.warnings),
  }
}

function normalizeImoLookupDraft(value: unknown): ParserImoLookupDraft {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    imo: cleanImo(source.imo),
    confidence: cleanConfidence(source.confidence),
    warning: cleanText(source.warning),
  }
}

function injectImoIntoSlashOutput(output: string, imo: string, vesselName: string) {
  const cleanOutput = cleanText(output)
  if (!cleanOutput || !imo || /\b\d{7}\b/.test(cleanOutput)) return output

  const parts = cleanOutput
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
  const firstPart = parts[0] || cleanText(vesselName).toLowerCase()
  if (!firstPart) return output

  return [firstPart, imo, ...parts.slice(1)].filter(Boolean).join(" / ")
}

function stripImoFromSlashOutput(output: string, imo: string) {
  if (!output || !imo) return output
  return output
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== imo)
    .join(" / ")
}

const MONTH_PATTERN =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"

const DATE_ONLY_PATTERNS = [
  new RegExp(`^\\d{1,2}(?:\\s*(?:-|to|/)\\s*\\d{1,2})?\\s*${MONTH_PATTERN}\\b(?:\\s*,?\\s*\\d{2,4})?$`, "i"),
  new RegExp(`^${MONTH_PATTERN}\\s*\\d{1,2}(?:\\s*(?:-|to|/)\\s*\\d{1,2})?(?:\\s*,?\\s*\\d{2,4})?$`, "i"),
]

const DATE_EXPRESSION_PATTERN = new RegExp(
  `(?:\\d{1,2}\\s*(?:-|to|/)\\s*\\d{1,2}\\s*${MONTH_PATTERN}\\b|\\d{1,2}\\s*${MONTH_PATTERN}\\b|${MONTH_PATTERN}\\s*\\d{1,2})`,
  "i",
)

const NON_DATE_ONLY_TOKEN_PATTERN =
  /\b(?:vlsfo|lsfo|hsfo|hfo|ifo|lsmgo|mgo|mdo|dma|dmb|cst|mt|mts|kl|cbm|rmk|remarks?|account|buyer|imo)\b/i

function displayPortForShortenedOutput(value: string) {
  const normalized = cleanText(value).toLowerCase()
  return normalized === "hong kong" || normalized === "hongkong" || normalized === "hkg" || normalized === "香港"
    ? "hk"
    : normalized
}

function isDateOnlySegment(value: string) {
  const normalized = cleanText(value).toLowerCase()
  if (!normalized || NON_DATE_ONLY_TOKEN_PATTERN.test(normalized)) return false
  return DATE_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))
}

function getPortOnlySegment(value: string) {
  const normalized = cleanText(value).toLowerCase()
  if (!normalized || /\d/.test(normalized)) return ""

  const beforeComma = normalized.split(/[,，]/)[0] || normalized
  const withoutCountry = beforeComma
    .replace(/\s+(?:china|taiwan|korea|south korea|malaysia|japan|indonesia|thailand|vietnam|viet nam|uae|united arab emirates|india|singapore)$/i, "")
    .trim()
  const port =
    extractEnquiryPort(normalized) ||
    extractEnquiryPort(beforeComma) ||
    extractEnquiryPort(withoutCountry)
  if (!port) return ""

  const displayPort = displayPortForShortenedOutput(port)
  if (displayPortForShortenedOutput(normalized) === displayPort) return displayPort
  if (displayPortForShortenedOutput(withoutCountry) === displayPort) return displayPort

  return displayPortForShortenedOutput(beforeComma) === displayPort ? displayPort : ""
}

function normalizeHongKongScheduleSegment(value: string) {
  const normalized = cleanText(value)
  if (!normalized || extractEnquiryPort(normalized) !== "hong kong") return normalized
  if (!DATE_EXPRESSION_PATTERN.test(normalized)) return normalized

  return normalized.replace(/^(?:(?:hong\s*kong|hongkong|hkg|hk)\b\s*|香港\s*)/i, "hk ")
}

function normalizeEnquiryWorksheetAiOutput(output: string) {
  const parts = cleanText(output)
    .split("/")
    .map((part) => cleanText(part))
    .filter(Boolean)

  const normalized: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    const next = parts[index + 1] || ""
    const port = getPortOnlySegment(part)

    if (port && isDateOnlySegment(next)) {
      normalized.push(`${port} ${next.toLowerCase()}`)
      index += 1
      continue
    }

    normalized.push(normalizeHongKongScheduleSegment(part))
  }

  return normalized.join(" / ")
}

function textContainsImo(imo: string, ...values: string[]) {
  if (!imo) return false
  return values.some((value) => new RegExp(`(^|\\D)${imo}(?=$|\\D)`).test(value))
}

function compactLookupText(value: string) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function sourceSupportsImo(source: ParserAiSourceLink, vesselName: string, imo: string) {
  const sourceText = `${source.title} ${source.url}`
  return sourceText.includes(imo) && compactLookupText(sourceText).includes(compactLookupText(vesselName))
}

function getHongKongDateKey() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())

  const year = parts.find((part) => part.type === "year")?.value || "2026"
  const month = parts.find((part) => part.type === "month")?.value || "01"
  const day = parts.find((part) => part.type === "day")?.value || "01"
  return `${year}-${month}-${day}`
}

function buildInstructions(source: ParserAiSource) {
  const today = getHongKongDateKey()
  const sourceRule = source === "spc"
    ? "SPC output must not include port. Singapore is assumed. Leave buyer empty. Leave remarks empty unless the user explicitly wrote a non-product instruction that must be retained."
    : "Enquiryworksheet output must include port when known, including Singapore. Combine port and date into one slash segment, e.g. vessel / imo / taichung 10 - 14 jul / vlsfo 80mts, never vessel / imo / taichung / 10 - 14 jul / vlsfo 80mts. Return buyer only in the buyer field, not inside correctedOutput."

  return [
    "You correct bunker enquiry parser output for FCUNO/SPC users.",
    `Today is ${today} in Asia/Hong_Kong. Resolve missing months only when the input makes that unavoidable.`,
    sourceRule,
    "Return one corrected slash-separated enquiry line in correctedOutput.",
    "Do not invent vessel name, port, buyer, date, product, or quantity. Use empty strings and warnings when unclear.",
    "For IMO, first extract it from the input. If no IMO is written but the vessel name is clear, you may provide the IMO from strong vessel knowledge only when highly confident; otherwise leave IMO empty and add a warning.",
    "Use lower-case vessel, port, eta, vlsfo, and lsmgo in correctedOutput. Use HSFO uppercase.",
    "Use hk in correctedOutput for HK, HKG, Hong Kong, Hongkong, and 香港.",
    "Prefer these port spellings: busan, yosu, port klang, inchon.",
    "Normalize quantities to mts, e.g. 100mt -> 100mts and 735-770mt -> 735-770mts.",
    "Classify VLSFO/LSFO/0.5/RMG180/RMG380/120CST/180CST as VLSFO. Do not convert VLSFO into HSFO because of nearby quantity numbers.",
    "Classify HSFO/HFO/IFO/3.5 as HSFO only when explicitly present as a fuel/spec, not when 3 or 5 appears in dates or quantities.",
    "Classify LSMGO/MGO/MDO/DMA/DMB/LEMGO as lsmgo.",
    "Only include 180CST MAX or 120CST MAX when the input explicitly says 180cst, 120cst, rmg180, rmg120, ls180cst, or ls120cst. If only 180 or 120 appears as a quantity/date, add a warning instead.",
    "If RMK, CBM, or KL appears, add a warning.",
    "Return vlsfoMaxRemarks as lower-case enum values only.",
  ].join("\n")
}

function buildFallbackOutput(
  source: ParserAiSource,
  rawText: string,
  cleanedText: string,
  draft: ParserAiDraft,
) {
  const sourceText = cleanedText || rawText
  const vlsfoMaxRemarks = draft.vlsfoMaxRemarks.length
    ? draft.vlsfoMaxRemarks
    : detectVlsfoMaxRemarks(draft.correctedOutput)

  if (source === "spc") {
    const standard = buildSpcStandardEnquiry({
      vesselName: draft.vesselName,
      imo: draft.imo,
      eta: draft.eta,
      hsfo: draft.hsfo,
      vlsfo: draft.vlsfo,
      lsmgo: draft.lsmgo,
      remarks: draft.remarks,
      vlsfoMaxRemarks,
    })
    return cleanSpcEnquiryText(standard || draft.correctedOutput)
  }

  if (draft.correctedOutput) return draft.correctedOutput

  return buildShortenedEnquiry(
    sourceText,
    draft.vesselName,
    draft.imo,
    vlsfoMaxRemarks,
    {
      autoDetectVlsfoRemarks: false,
      includePort: true,
      port: draft.port,
    },
  )
}

function normalizeOutputForSource(
  source: ParserAiSource,
  rawText: string,
  cleanedText: string,
  draft: ParserAiDraft,
) {
  const correctedOutput = buildFallbackOutput(source, rawText, cleanedText, draft)
  const vlsfoMaxRemarks = draft.vlsfoMaxRemarks.length
    ? draft.vlsfoMaxRemarks
    : detectVlsfoMaxRemarks(correctedOutput)

  if (source === "spc") {
    const parsed = parseSpcEnquiryText(correctedOutput, vlsfoMaxRemarks)
    return {
      ...draft,
      correctedOutput: parsed.standardText || correctedOutput,
      vesselName: draft.vesselName || parsed.vesselName,
      imo: draft.imo || parsed.imo,
      eta: draft.eta || parsed.eta,
      hsfo: draft.hsfo || parsed.hsfo,
      vlsfo: draft.vlsfo || parsed.vlsfo,
      lsmgo: draft.lsmgo || parsed.lsmgo,
      remarks: draft.remarks || parsed.remarks,
      port: "",
      buyer: "",
      vlsfoMaxRemarks,
    }
  }

  const worksheetOutput = normalizeEnquiryWorksheetAiOutput(correctedOutput)
  const guess = parseEnquiryWorksheetGuess(worksheetOutput)
  return {
    ...draft,
    correctedOutput: worksheetOutput,
    vesselName: draft.vesselName || guess.vesselName,
    imo: draft.imo || guess.imo,
    port: draft.port || guess.port,
    buyer: draft.buyer || guess.buyer,
    vlsfoMaxRemarks,
  }
}

function correctedOutputWithImo(
  source: ParserAiSource,
  rawText: string,
  cleanedText: string,
  draft: ParserAiDraft,
  imo: string,
) {
  const nextDraft = { ...draft, imo }
  if (source === "spc") {
    return cleanSpcEnquiryText(
      buildSpcStandardEnquiry({
        vesselName: nextDraft.vesselName,
        imo,
        eta: nextDraft.eta,
        hsfo: nextDraft.hsfo,
        vlsfo: nextDraft.vlsfo,
        lsmgo: nextDraft.lsmgo,
        remarks: nextDraft.remarks,
        vlsfoMaxRemarks: nextDraft.vlsfoMaxRemarks,
      }) || injectImoIntoSlashOutput(nextDraft.correctedOutput, imo, nextDraft.vesselName),
    )
  }

  if (nextDraft.correctedOutput) {
    return normalizeEnquiryWorksheetAiOutput(
      injectImoIntoSlashOutput(nextDraft.correctedOutput, imo, nextDraft.vesselName),
    )
  }

  const sourceText = cleanedText || rawText
  return normalizeEnquiryWorksheetAiOutput(
    buildShortenedEnquiry(
      sourceText,
      nextDraft.vesselName,
      imo,
      nextDraft.vlsfoMaxRemarks,
      {
        autoDetectVlsfoRemarks: false,
        includePort: true,
        port: nextDraft.port,
      },
    ),
  )
}

async function lookupImoWithWebSearch(apiKey: string, model: string, vesselName: string) {
  const cleanedVessel = cleanText(vesselName)
  if (!cleanedVessel) return null

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_IMO_LOOKUP_MODEL || model,
        store: false,
        instructions: [
          "Find the vessel IMO number from public web results.",
          "Use web search. Return an IMO only when one unique valid 7-digit IMO clearly matches the vessel name.",
          "If multiple vessels, multiple IMO candidates, no match, or weak evidence, return an empty IMO.",
          "If returning an IMO, set warning to exactly: IMO found by web search; please double check.",
        ].join("\n"),
        tools: [{ type: "web_search", search_context_size: "low" }],
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
        input: `Vessel name: ${cleanedVessel}\nSearch query: "${cleanedVessel}" vessel IMO`,
        text: {
          format: {
            type: "json_schema",
            name: "vessel_imo_lookup",
            strict: true,
            schema: PARSER_IMO_LOOKUP_SCHEMA,
          },
        },
      }),
    })

    const lookupPayload = await response.json().catch(() => ({}))
    if (!response.ok) return null
    const outputText = extractOutputText(lookupPayload)
    if (!outputText) return null

    const draft = normalizeImoLookupDraft(JSON.parse(outputText))
    const sources = extractWebSourceLinks(lookupPayload)
    if (!draft.imo || draft.confidence < 0.6) return null
    if (!sources.some((source) => sourceSupportsImo(source, cleanedVessel, draft.imo))) return null
    return {
      imo: draft.imo,
      warning: draft.warning || "IMO found by web search; please double check.",
      sources,
    }
  } catch {
    return null
  }
}

async function requireAccess(source: ParserAiSource) {
  if (source === "spc") {
    await requireSpcPagePermission("spc-buyer-enquiries", "edit")
    return
  }

  await requireAdminPagePermission("enquiry-worksheet", "edit")
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "AI parser request failed."
  const status =
    error instanceof HttpError
      ? error.status
      : message === "Unauthorized"
        ? 401
        : message === "Forbidden"
          ? 403
          : 500

  return NextResponse.json({ message }, { status })
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ParserAiPayload
    const source = sourceFrom(payload.source)
    if (!source) {
      return NextResponse.json({ message: "Parser source is required." }, { status: 400 })
    }

    await requireAccess(source)

    const rawText = asString(payload.rawText)
    const cleanedText = asString(payload.cleanedText)
    const parserOutput = asString(payload.parserOutput, 5_000)
    const currentOutput = asString(payload.currentOutput, 5_000)
    if (!rawText && !cleanedText) {
      return NextResponse.json({ message: "Raw enquiry is required." }, { status: 400 })
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new HttpError("OPENAI_API_KEY is not configured.", 503)
    }

    const model = process.env.OPENAI_PARSER_MODEL || MODEL
    const input = [
      `Source: ${source}`,
      `Context: ${cleanText(payload.context) || "parser-correction"}`,
      `Manual VLSFO max remarks: ${JSON.stringify(cleanVlsfoMaxRemarks(payload.manualVlsfoMaxRemarks))}`,
      `Current fields JSON: ${JSON.stringify(payload.fields || {})}`,
      `Current deterministic parser output:\n${parserOutput || "(empty)"}`,
      `Current user-edited output:\n${currentOutput || "(empty)"}`,
      `Raw enquiry:\n${rawText || cleanedText}`,
      cleanedText && cleanedText !== rawText ? `Cleaned enquiry:\n${cleanedText}` : "",
    ].filter(Boolean).join("\n\n")

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        instructions: buildInstructions(source),
        input,
        text: {
          format: {
            type: "json_schema",
            name: "bunker_parser_correction",
            strict: true,
            schema: PARSER_AI_SCHEMA,
          },
        },
      }),
    })

    const aiPayload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new HttpError(getAiErrorMessage(aiPayload, "OpenAI request failed."), response.status)
    }

    const outputText = extractOutputText(aiPayload)
    if (!outputText) throw new Error("OpenAI returned no parser correction.")

    let parsed: unknown
    try {
      parsed = JSON.parse(outputText)
    } catch {
      throw new Error("OpenAI returned an unreadable parser correction.")
    }

    let draft = normalizeOutputForSource(
      source,
      rawText,
      cleanedText,
      normalizeDraft(parsed),
    )

    if (draft.imo && !textContainsImo(draft.imo, rawText, cleanedText, parserOutput, currentOutput)) {
      draft = {
        ...draft,
        imo: "",
        correctedOutput: stripImoFromSlashOutput(draft.correctedOutput, draft.imo),
      }
    }

    let imoSources: ParserAiSourceLink[] = []
    if (!draft.imo && draft.vesselName) {
      const imoLookup = await lookupImoWithWebSearch(apiKey, model, draft.vesselName)
      if (imoLookup?.imo) {
        imoSources = imoLookup.sources
        draft = {
          ...draft,
          imo: imoLookup.imo,
          correctedOutput: correctedOutputWithImo(source, rawText, cleanedText, draft, imoLookup.imo),
          warnings: uniqueWarnings([
            ...draft.warnings,
            imoLookup.warning,
          ]),
        }
      }
    }

    if (draft.imo && !textContainsImo(draft.imo, draft.correctedOutput)) {
      draft = {
        ...draft,
        correctedOutput: correctedOutputWithImo(source, rawText, cleanedText, draft, draft.imo),
      }
    }

    return NextResponse.json({
      success: true,
      source,
      model,
      correctedOutput: draft.correctedOutput,
      fields: {
        vesselName: draft.vesselName,
        imo: draft.imo,
        port: draft.port,
        buyer: draft.buyer,
        eta: draft.eta,
        hsfo: draft.hsfo,
        vlsfo: draft.vlsfo,
        lsmgo: draft.lsmgo,
        remarks: draft.remarks,
      },
      vlsfoMaxRemarks: draft.vlsfoMaxRemarks,
      confidence: draft.confidence,
      warnings: draft.warnings,
      imoSources,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
