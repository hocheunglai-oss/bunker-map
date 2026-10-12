import type { ReportSnapshotKey } from "@/lib/reportSnapshots"
import { formatReportDate } from "@/lib/taiwanReport"

export type PublicationBaseline = {
  report: ReportSnapshotKey
  sourceVersion: string
  publicationVersion: string
  preview: Record<string, unknown>
  publishedReportDate: string | null
  publishedReportDamaged?: boolean
}
const VERSION = /^[a-f0-9]{64}$/
const FUELS = ["hsfo", "vlsfo", "mgo"] as const
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Incomplete saved report")
  return value as Record<string, unknown>
}
function number(value: unknown, negative = false) {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || !negative && value < 0)) throw Error("Invalid saved report price")
}
function rows(value: unknown, report: ReportSnapshotKey) {
  if (!Array.isArray(value) || !value.length || value.length > 2000) throw Error("Incomplete saved report rows")
  const names = new Set<string>()
  for (const item of value) {
    const row = object(item)
    if (typeof row.port !== "string" || !row.port.trim() || row.port.length > 200 || names.has(row.port)) throw Error("Invalid saved report port")
    names.add(row.port)
    for (const fuel of FUELS) {
      if (report === "china" || report === "compact") number(row[fuel])
      else {
        const snapshot = object(row[fuel])
        for (const key of report === "hongkong" ? ["today", "last1", "last2"] : ["today", "last", "change"]) number(snapshot[key], key === "change")
      }
    }
    if (report === "hongkong") for (const key of ["todayDate", "last1Date", "last2Date"]) {
      if (row[key] !== null && (typeof row[key] !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(row[key]))) throw Error("Invalid saved history date")
    }
  }
  if (report === "hongkong" && (value.length !== 1 || !names.has("Hong Kong"))) throw Error("Incomplete Hong Kong report")
  if (report === "taiwan" && (value.length !== 5 || ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"].some(name => !names.has(name)))) throw Error("Incomplete Taiwan report")
}

/** Validate before exposing a ready button or rendering a server preview. */
export function parsePublicationBaseline(value: unknown, report: ReportSnapshotKey): PublicationBaseline {
  const data = object(value), preview = object(data.preview)
  if (data.report !== report || typeof data.sourceVersion !== "string" || !VERSION.test(data.sourceVersion)
    || typeof data.publicationVersion !== "string" || !VERSION.test(data.publicationVersion)
    || typeof preview.reportDate !== "string" || !/^\d{2} [A-Za-z]{3,4} \d{4}$/.test(preview.reportDate)
    || data.publishedReportDate !== null && (typeof data.publishedReportDate !== "string" || data.publishedReportDate.length > 80)
    || data.publishedReportDamaged !== undefined && typeof data.publishedReportDamaged !== "boolean"
    || data.publishedReportDamaged === true && data.publishedReportDate !== null) throw Error("Invalid saved report baseline")
  const parsedDay = new Date(`${preview.reportDate} 12:00:00 GMT`)
  if (!Number.isFinite(parsedDay.getTime()) || formatReportDate(parsedDay.toISOString().slice(0, 10)) !== preview.reportDate) throw Error("Invalid saved report date")
  if (report === "hongkong" || report === "taiwan") rows(preview.rows, report)
  else {
    if (!Array.isArray(preview.sections) || !preview.sections.length || preview.sections.length > 200) throw Error("Incomplete saved report sections")
    for (const item of preview.sections) {
      const section = object(item)
      if (typeof section.title !== "string" || !section.title.trim() || section.title.length > 200) throw Error("Invalid saved report section")
      rows(section.rows, report)
    }
  }
  if (report === "taiwan") for (const key of ["remark", "specialNotice"]) {
    if (typeof preview[key] !== "string" || preview[key].length > 1_048_576) throw Error("Incomplete saved report notices")
  }
  return data as PublicationBaseline
}
