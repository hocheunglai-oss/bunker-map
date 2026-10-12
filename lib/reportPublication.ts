import { chinaReportSections, compactReportSections } from "@/data/reportSections"
import { buildChinaReportSections } from "@/lib/chinaReport"
import { buildHongKongReportRows } from "@/lib/hongKongReport"
import { buildTaiwanReportRows, formatReportDate } from "@/lib/taiwanReport"
import { parseSimpleFormula, type FuelKey, type FormulaCapablePort } from "@/lib/portPricing"
import { parseHistoryRows } from "@/lib/marketPriceHistory"
import type { ReportSnapshotKey } from "@/lib/reportSnapshots"
import { parsePublicReportJson, validatePublicReportSnapshot } from "@/lib/publicReportValidation"

export const REPORT_PUBLICATIONS = {
  hongkong: { id: 102, page: "hongkong-price-history", names: ["Hong Kong"] },
  taiwan: { id: 101, page: "taiwan-price-history", names: ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"] },
  china: { id: 103, page: "pricesetter", names: [...new Set(chinaReportSections.flatMap(s => s.ports))] },
  compact: { id: 104, page: "pricesetter", names: [...new Set(compactReportSections.flatMap(s => s.ports))] },
} as const
export class ReportPublicationInputError extends Error {}
export function parseReportPublicationTarget(report: unknown, page: unknown) {
  if (typeof report !== "string" || !Object.hasOwn(REPORT_PUBLICATIONS, report)) throw new ReportPublicationInputError("Choose a valid report.")
  const key = report as ReportSnapshotKey
  if (page !== "pricesetter" && page !== REPORT_PUBLICATIONS[key].page) throw new ReportPublicationInputError("Choose the correct report page.")
  return { report: key, page: page as string, names: REPORT_PUBLICATIONS[key].names.map(name => name.toLowerCase()) }
}
export function isReportDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01") return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function parseReportPublicationInput(value: unknown) {
  const fail = () => new ReportPublicationInputError("Reload the report before publishing, and check its date.")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail()
  const input = value as Record<string, unknown>
  const keys = ["sourceVersion", "publicationVersion", "dateOverride"]
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
    || typeof input.sourceVersion !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceVersion)
    || typeof input.publicationVersion !== "string" || !/^[a-f0-9]{64}$/.test(input.publicationVersion)
    || input.dateOverride !== "" && !isReportDay(input.dateOverride)) throw fail()
  return input as { sourceVersion: string; publicationVersion: string; dateOverride: string }
}
type PublicationPort = FormulaCapablePort & { id: string; type: string | null; updated_at: string | null }
type SourceRow = { id: number; content: string | null }
type Source = {
  report: ReportSnapshotKey; ports: PublicationPort[];
  history: ReturnType<typeof parseHistoryRows>; notices: SourceRow[]; publication: SourceRow | null
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const PORT_KEYS = ["id", "name", "type", "hsfo", "vlsfo", "mgo", "hsfo_formula", "vlsfo_formula", "mgo_formula", "updated_at"]
const FUELS: FuelKey[] = ["hsfo", "vlsfo", "mgo"]
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Incomplete report source")
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw Error("Incomplete report source")
}
function sourceRow(value: unknown, ids: number[]): SourceRow {
  const row = object(value); exact(row, ["id", "content"])
  if (typeof row.id !== "number" || !ids.includes(row.id) || row.content !== null && (typeof row.content !== "string" || row.content.length > 1_048_576)) throw Error("Incomplete report text")
  return row as SourceRow
}
export function parseReportPublicationSource(value: unknown, report: ReportSnapshotKey): Source {
  const source = object(value); exact(source, ["report", "ports", "history", "notices", "publication"])
  if (source.report !== report || !Array.isArray(source.ports) || source.ports.length < 1 || source.ports.length > 2000) throw Error("Incomplete report ports")
  const ids = new Set<string>(), names = new Set<string>()
  const ports = source.ports.map(value => {
    const port = object(value); exact(port, PORT_KEYS)
    if (typeof port.id !== "string" || !UUID.test(port.id) || ids.has(port.id)
      || typeof port.name !== "string" || !port.name.trim() || port.name.length > 200 || names.has(port.name.trim().toLowerCase())
      || port.type !== null && port.type !== "port" || port.updated_at !== null && !isReportDay(port.updated_at)) throw Error("Invalid report port")
    for (const fuel of FUELS) {
      if (port[fuel] !== null && (typeof port[fuel] !== "number" || !Number.isFinite(port[fuel]) || port[fuel] < 0)) throw Error("Invalid report price")
      const formula = port[`${fuel}_formula`]
      if (formula !== null && (typeof formula !== "string" || formula.length > 500)) throw Error("Invalid report formula")
    }
    ids.add(port.id); names.add(port.name.trim().toLowerCase())
    // Helpers use normalized lookups but display canonical configured root names.
    const name = REPORT_PUBLICATIONS[report].names.find(n => n.toLowerCase() === port.name!.toString().trim().toLowerCase()) || port.name.trim()
    return { ...port, name } as PublicationPort
  })
  const history = parseHistoryRows(source.history, ports)
  if (history.length > ports.length * 3 || report !== "taiwan" && report !== "hongkong" && history.length) throw Error("Incomplete report history")
  const days = new Set<string>()
  for (const row of history) {
    const key = `${row.port_id}:${row.recorded_at.slice(0, 10)}`
    if (days.has(key)) throw Error("Ambiguous report history")
    days.add(key)
  }
  if (!Array.isArray(source.notices) || source.notices.length > 2 || report !== "taiwan" && source.notices.length) throw Error("Incomplete report notices")
  const notices = source.notices.map(row => sourceRow(row, [1, 2]))
  if (new Set(notices.map(row => row.id)).size !== notices.length) throw Error("Ambiguous report notices")
  const publication = source.publication === null ? null : sourceRow(source.publication, [REPORT_PUBLICATIONS[report].id])
  // The old publication is an opaque, versioned replacement baseline. Damaged
  // content must not prevent reviewing valid source prices and repairing it.
  return { report, ports, history, notices, publication }
}

export function inspectSavedReportPublication(content: string | null | undefined, report: ReportSnapshotKey) {
  try {
    const value = parsePublicReportJson(content)
    return { damaged: false, snapshot: value === null ? null : validatePublicReportSnapshot(value, report) }
  } catch { return { damaged: true, snapshot: null } }
}

export function buildReportPublication(source: Source, dateOverride = "") {
  if (dateOverride && !isReportDay(dateOverride)) throw new ReportPublicationInputError("Choose a valid report date.")
  const { report, ports, history, notices } = source
  const wanted = new Set(REPORT_PUBLICATIONS[report].names.map(name => name.toLowerCase()))
  const roots = ports.filter(port => wanted.has(port.name.toLowerCase()))
  if ((report === "taiwan" || report === "hongkong") && roots.length !== wanted.size) throw Error("Missing report port")
  const byName = new Map(ports.map(port => [port.name.toLowerCase(), port]))
  const used = new Set<string>()
  function validateDependency(port: PublicationPort, fuel: FuelKey, seen = new Set<string>()) {
    const key = `${port.id}:${fuel}`
    if (seen.has(key)) throw Error("Circular report formula")
    seen.add(key); used.add(port.id)
    const fallback = report === "taiwan" && ["keelung", "suao", "hualien"].includes(port.name.toLowerCase()) && fuel !== "hsfo" ? "Taichung + 0" : null
    const formula = port[`${fuel}_formula`]?.trim() || fallback
    if (formula) {
      const parsed = parseSimpleFormula(formula)
      if (!parsed || !Number.isFinite(parsed.amount)) throw Error("Invalid report formula")
      const dependency = byName.get(parsed.refName)
      if (!dependency) throw Error("Missing report formula basis")
      validateDependency(dependency, fuel, seen)
    }
  }
  if (report !== "hongkong") for (const port of roots) for (const fuel of FUELS) {
    if (report === "taiwan" && fuel === "hsfo" && port.name !== "Kaohsiung") continue
    validateDependency(port, fuel)
  }
  else roots.forEach(port => used.add(port.id))
  const times = report === "taiwan" || report === "hongkong"
    ? history.filter(row => used.has(String(row.port_id))).map(row => row.recorded_at.slice(0, 10))
    : ports.filter(port => used.has(port.id)).map(port => port.updated_at).filter((date): date is string => Boolean(date))
  const day = dateOverride || times.sort().at(-1)
  if (!day || !isReportDay(day)) throw Error("No saved report date")
  const reportDate = formatReportDate(day)
  let payload: Record<string, unknown>
  if (report === "hongkong") {
    if (!history.some(row => row.port_id === roots[0].id)) throw Error("No saved Hong Kong history")
    payload = { reportDate, rows: buildHongKongReportRows(roots, history, [...REPORT_PUBLICATIONS.hongkong.names]) }
  } else if (report === "taiwan") {
    for (const name of ["Kaohsiung", "Taichung"]) if (!history.some(row => row.port_id === byName.get(name.toLowerCase())?.id)) throw Error("Missing Taiwan history")
    payload = { reportDate, rows: buildTaiwanReportRows(roots, history, [...REPORT_PUBLICATIONS.taiwan.names], ports),
      remark: notices.find(row => row.id === 1)?.content || "", specialNotice: notices.find(row => row.id === 2)?.content || "" }
  } else {
    const sections = buildChinaReportSections(roots, report === "china" ? chinaReportSections : compactReportSections, ports)
    // Preserve configured optional aliases/regions; completeness is guaranteed
    // by the coherent reader, not by inventing mandatory ports that do not exist.
    if (!sections.length) throw Error("No saved report ports")
    payload = { reportDate, sections }
  }
  // The writer and public consumers must agree on what can be displayed.
  validatePublicReportSnapshot(payload, report)
  return payload
}
