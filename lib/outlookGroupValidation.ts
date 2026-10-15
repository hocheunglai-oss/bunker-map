export const OUTLOOK_GROUP_EDIT_FIELDS = ["name", "source_book", "nickname", "description"] as const

export type OutlookGroupFields = {
  name: string
  source_book: string
  nickname: string | null
  description: string | null
}

export type SavedOutlookGroup = OutlookGroupFields & {
  id: string
  source_uid: string
  member_count: number
  updated_at: string
}

export type OutlookGroupMember = { group_id: string; contact_id: string; source_book: string }

export const OUTLOOK_GROUP_CONFLICT_MESSAGE = "This group changed or was deleted. Your edits are still here. Copy them before reloading the group."

const cleanText = (value: string) => value.replace(/\s+/g, " ").trim()

export function normalizeOutlookGroupFields(input: OutlookGroupFields): OutlookGroupFields {
  return {
    name: cleanText(input.name),
    source_book: cleanText(input.source_book),
    nickname: input.nickname ? cleanText(input.nickname) || null : null,
    description: input.description ? input.description.trim() || null : null,
  }
}

export function validateOutlookGroupFields(input: Partial<OutlookGroupFields>, mode: "create" | "update" = "create"): string | null {
  for (const [field, label] of [["name", "Group name"], ["source_book", "Source book"]] as const) {
    if (mode === "create" || Object.prototype.hasOwnProperty.call(input, field)) {
      if (typeof input[field] !== "string" || !input[field].trim()) return `${label} is required.`
    }
  }
  for (const field of OUTLOOK_GROUP_EDIT_FIELDS) {
    const value = input[field]
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue
    if (value !== null && typeof value !== "string") return "Group details must be text."
    if (typeof value === "string" && value.includes("\u0000")) return "Group details cannot contain null characters."
  }
  return null
}

/** Preserve raw PostgreSQL microseconds; do not round versions through Date. */
export function isOutlookGroupVersion(value: unknown): value is string {
  if (typeof value !== "string") return false
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/)
  if (!parts || Number(parts[1]) < 1 || !Number.isFinite(Date.parse(value))) return false
  const date = new Date(0)
  date.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return date.getUTCFullYear() === Number(parts[1]) && date.getUTCMonth() === Number(parts[2]) - 1 && date.getUTCDate() === Number(parts[3])
}

export function isSavedOutlookGroup(value: unknown, id: string, expectedUpdatedAt?: string): value is SavedOutlookGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.id === id && typeof row.source_uid === "string" &&
    typeof row.name === "string" && typeof row.source_book === "string" &&
    (row.nickname === null || typeof row.nickname === "string") &&
    (row.description === null || typeof row.description === "string") &&
    Number.isInteger(row.member_count) && Number(row.member_count) >= 0 &&
    isOutlookGroupVersion(row.updated_at) &&
    (expectedUpdatedAt === undefined || row.updated_at !== expectedUpdatedAt)
}

/** Count-changing member edits touch the parent version. Legacy same-count
 * member UPDATEs may not, so also compare two complete membership reads. */
export async function readStableOutlookGroupSnapshot(id: string, loadGroup: () => Promise<unknown>, loadMembers: () => Promise<unknown>) {
  const members = (rows: unknown): OutlookGroupMember[] => {
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || row.group_id !== id || typeof row.contact_id !== "string" || !row.contact_id || typeof row.source_book !== "string") ||
        new Set(rows.map(row => row.contact_id)).size !== rows.length) {
      throw new Error("The group members could not be verified. Reload the group before editing.")
    }
    return rows
  }
  const fingerprint = (rows: OutlookGroupMember[]) => JSON.stringify(rows.map(row => ({ contact_id: row.contact_id, source_book: row.source_book })).sort((a, b) => a.contact_id < b.contact_id ? -1 : a.contact_id > b.contact_id ? 1 : 0))
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await loadGroup()
    if (!isSavedOutlookGroup(before, id)) throw new Error("The group could not be reloaded. Your data is still here.")
    const rows = members(await loadMembers())
    const after = await loadGroup()
    if (!isSavedOutlookGroup(after, id)) throw new Error("The group could not be reloaded. Your data is still here.")
    if (before.updated_at !== after.updated_at || after.member_count !== rows.length) continue
    const verifiedMembers = members(await loadMembers())
    if (fingerprint(rows) === fingerprint(verifiedMembers)) return { group: after, members: verifiedMembers }
  }
  throw new Error("The group changed while reloading. Your data is still here; reload again before editing.")
}
