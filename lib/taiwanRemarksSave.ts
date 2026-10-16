import { validateTaiwanNoticeDraft } from "@/lib/taiwanNoticeTemplates"
import { readPublicOperationalNotice } from "@/lib/publicReportValidation"

export const TAIWAN_REMARK_IDS = [1, 2, 3] as const
export type TaiwanRemarkId = typeof TAIWAN_REMARK_IDS[number]
export type TaiwanRemarkBaseline = { id: TaiwanRemarkId; exists: boolean; content: string | null }
export type TaiwanRemarkChange = { id: TaiwanRemarkId; expected: TaiwanRemarkBaseline; content: string }
export const TAIWAN_REMARKS_CONFLICT = "The remarks changed in another session. Your draft is still here; reload the saved remarks before trying again."
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const id = (value: unknown): value is TaiwanRemarkId => typeof value === "number" && TAIWAN_REMARK_IDS.some(id => id === value)
const text = (value: unknown): value is string => typeof value === "string" && !value.includes("\u0000") && new TextEncoder().encode(value).byteLength <= 1_048_576

export function captureTaiwanRemarkBaselines(value: unknown): TaiwanRemarkBaseline[] {
  if (!Array.isArray(value)) throw Error("Incomplete saved remarks")
  const seen = new Map<TaiwanRemarkId, string | null>()
  for (const row of value) {
    if (!record(row) || !id(row.id) || seen.has(row.id) || row.content !== null && !text(row.content)) throw Error("Incomplete saved remarks")
    seen.set(row.id, row.content as string | null)
  }
  return TAIWAN_REMARK_IDS.map(id => ({ id, exists: seen.has(id), content: seen.get(id) ?? null }))
}

export function parseTaiwanRemarksSave(value: unknown): TaiwanRemarkChange[] {
  if (!record(value) || !exact(value, ["changes"]) || !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 3) throw Error("Invalid remarks")
  const seen = new Set<TaiwanRemarkId>()
  return value.changes.map(change => {
    if (!record(change) || !exact(change, ["id", "expected", "content"]) || !id(change.id) || seen.has(change.id) || !text(change.content)
      || !record(change.expected) || !exact(change.expected, ["id", "exists", "content"]) || change.expected.id !== change.id
      || typeof change.expected.exists !== "boolean" || change.expected.content !== null && !text(change.expected.content)
      || !change.expected.exists && change.expected.content !== null
      || change.id !== 3 && Boolean(change.content.trim()) && validateTaiwanNoticeDraft(change.content)) throw Error("Invalid remarks")
    seen.add(change.id)
    if (change.id === 3) readPublicOperationalNotice(change.content)
    return change as TaiwanRemarkChange
  }).sort((a, b) => a.id - b.id)
}

export function confirmedTaiwanRemarksSave(value: unknown, changes: TaiwanRemarkChange[]): value is { rows: Array<{ id: TaiwanRemarkId; content: string }>; replayed: boolean } {
  if (!record(value) || !exact(value, ["rows", "replayed"]) || typeof value.replayed !== "boolean" || !Array.isArray(value.rows) || value.rows.length !== changes.length) return false
  const expected = new Map(changes.map(change => [change.id, change.content]))
  const seen = new Set<TaiwanRemarkId>()
  return value.rows.every(row => {
    if (!record(row) || !exact(row, ["id", "content"]) || !id(row.id) || seen.has(row.id) || expected.get(row.id) !== row.content) return false
    seen.add(row.id)
    return true
  })
}
