import { priceSetterTabs } from "@/data/priceSetterTabs"
import { chinaReportSections, compactReportSections } from "@/data/reportSections"

type PortAlias = {
  alias: string
  aliasKey: string
  label: string
  value: string
  pattern: RegExp
  short: boolean
}

export type EnquiryPortIndexOptions = {
  portNames?: string[]
  includeShortAliases?: boolean
}

const supplementalPorts = [
  "Caofeidian",
  "Colombo",
  "Hakata",
  "Hong Kong",
  "Laemchabang",
  "Nagasaki",
  "Pyeongtaek",
  "Shimonoseki",
  "Singapore",
  "Yokohama",
]

const preferredPortAliases: Array<{ label: string; aliases: string[]; short?: boolean }> = [
  { label: "Busan", aliases: ["Busan", "Pusan"] },
  { label: "Yosu", aliases: ["Yosu", "Yeosu"] },
  { label: "Port Klang", aliases: ["Port Klang", "Port Kelang", "Klang", "Kelang"] },
  { label: "Inchon", aliases: ["Inchon", "Incheon"] },
  { label: "Singapore", aliases: ["Singapore", "SGP", "SIN", "SG"], short: true },
  { label: "Hong Kong", aliases: ["Hong Kong", "Hongkong", "HK", "HKG", "香港"], short: true },
  { label: "Laemchabang", aliases: ["Laemchabang", "Laem Chabang"] },
  { label: "Ho Chi Minh", aliases: ["Ho Chi Minh", "Ho Chi Minh City", "Hochiminh City"] },
  { label: "Koh Sichang", aliases: ["Koh Sichang", "Kohsichang"] },
]

const preferredLabelsByAliasKey = new Map(
  preferredPortAliases.flatMap(({ label, aliases }) =>
    aliases.map((alias) => [normalizePortKey(alias), label] as const),
  ),
)

const basePortNames = Array.from(
  new Set(
    [
      ...supplementalPorts,
      ...chinaReportSections.flatMap((section) => section.ports),
      ...compactReportSections.flatMap((section) => section.ports),
      ...priceSetterTabs.flatMap((tab) => tab.ports),
    ]
      .map((port) => port.trim())
      .filter(Boolean),
  ),
)

let baseAliases: PortAlias[] | null = null
const dynamicAliasCache = new Map<string, PortAlias[]>()

function cleanPortLabel(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function normalizePortKey(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(/\u00ad/g, "")
    .replace(/[\u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/\bpt\b/g, "port")
    .replace(/\./g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function buildAliasPattern(aliasKey: string) {
  const words = aliasKey.split(" ").filter(Boolean)
  const body = words.map(escapeRegExp).join("[\\s.'/-]+")
  return new RegExp(`(^|[^A-Za-z0-9])(${body})(?=$|[^A-Za-z0-9])`, "i")
}

function portLabelFor(value: string) {
  const cleaned = cleanPortLabel(value)
  return preferredLabelsByAliasKey.get(normalizePortKey(cleaned)) || cleaned
}

function createPortAliases(portNames: string[]) {
  const byAliasKey = new Map<string, PortAlias>()

  function addAlias(alias: string, label: string, short = false) {
    const aliasKey = normalizePortKey(alias)
    if (!aliasKey) return

    const canonicalLabel = portLabelFor(label)
    const existing = byAliasKey.get(aliasKey)
    if (existing && existing.aliasKey.length >= aliasKey.length && !short) return

    byAliasKey.set(aliasKey, {
      alias,
      aliasKey,
      label: canonicalLabel,
      value: canonicalLabel.toLowerCase(),
      pattern: buildAliasPattern(aliasKey),
      short,
    })
  }

  preferredPortAliases.forEach(({ label, aliases, short }) => {
    aliases.forEach((alias) => addAlias(alias, label, Boolean(short && normalizePortKey(alias).length <= 3)))
  })
  portNames.forEach((port) => addAlias(port, port))

  return Array.from(byAliasKey.values()).sort((a, b) => {
    const words = b.aliasKey.split(" ").length - a.aliasKey.split(" ").length
    if (words !== 0) return words
    return b.aliasKey.length - a.aliasKey.length
  })
}

function getBaseAliases() {
  if (!baseAliases) baseAliases = createPortAliases(basePortNames)
  return baseAliases
}

function getPortAliases(portNames: string[] = []) {
  const cleanedDynamicNames = portNames.map(cleanPortLabel).filter(Boolean)
  if (cleanedDynamicNames.length === 0) return getBaseAliases()

  const key = Array.from(new Set(cleanedDynamicNames))
    .sort((a, b) => a.localeCompare(b))
    .join("\n")
  const cached = dynamicAliasCache.get(key)
  if (cached) return cached

  const aliases = createPortAliases([...basePortNames, ...cleanedDynamicNames])
  dynamicAliasCache.set(key, aliases)
  return aliases
}

export function findEnquiryPortInText(value: string, options: EnquiryPortIndexOptions = {}) {
  const text = String(value || "")
  if (!text.trim()) return ""

  const aliases = getPortAliases(options.portNames)
  const matches = aliases
    .filter((alias) => options.includeShortAliases || !alias.short)
    .flatMap((alias) => {
      const match = alias.pattern.exec(text)
      if (!match) return []
      return [{
        value: alias.value,
        aliasLength: alias.aliasKey.length,
        aliasWords: alias.aliasKey.split(" ").length,
        index: match.index + (match[1]?.length || 0),
      }]
    })
    .sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index
      if (a.aliasWords !== b.aliasWords) return b.aliasWords - a.aliasWords
      return b.aliasLength - a.aliasLength
    })

  return matches[0]?.value || ""
}

export function normalizeIndexedEnquiryPort(value: string, options: EnquiryPortIndexOptions = {}) {
  const key = normalizePortKey(value)
  if (!key) return ""
  const exact = getPortAliases(options.portNames)
    .filter((alias) => options.includeShortAliases || !alias.short)
    .find((alias) => alias.aliasKey === key)

  return exact?.value || ""
}
