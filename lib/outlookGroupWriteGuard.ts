import { validateOutlookGroupFields, type OutlookGroupFields } from "./outlookGroupValidation"

/** Old tabs must not recreate a deleted group or bypass versioned group edits. */
export function outlookGroupLegacyWriteMessage(table: string, method: string, prefer: string | null) {
  const action = method.toUpperCase()
  // A count-preserving identity replacement is not supported by the UI and
  // does not advance the existing parent member-count trigger's version.
  if (table === "shared_addressbook_group_members" && action === "PATCH") {
    return "Refresh Outlook Address Book and use Add Member or Remove. Group members have not been changed."
  }
  if (table !== "shared_addressbook_groups") return null
  const isUpsert = action === "POST" && /(?:^|,)\s*resolution\s*=\s*"?(?:merge|ignore)-duplicates"?\s*(?:,|$)/i.test(prefer || "")
  if (action !== "PATCH" && action !== "DELETE" && !isUpsert) return null
  return "Refresh Outlook Address Book before changing groups. Your existing contacts have not been changed."
}

/** A create is an INSERT only; versions and membership counts are server-owned. */
export function outlookGroupCreateValidationMessage(body: ArrayBuffer): string | null {
  let payload: unknown
  try { payload = JSON.parse(new TextDecoder().decode(body)) }
  catch { return "Group details must be valid JSON." }
  const rows = Array.isArray(payload) ? payload : [payload]
  if (!rows.length) return "Group details are required."
  const fields = new Set(["id", "source_uid", "name", "source_book", "nickname", "description", "member_count"])
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return "Group details must be an object."
    const input = row as Record<string, unknown>
    if (Object.keys(input).some(key => !fields.has(key))) return "Only new group details can be supplied. Reload the directory before retrying."
    for (const key of ["id", "source_uid"]) {
      if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 2048 || /[\u0000-\u001f\u007f]/.test(input[key])) return "A valid new group identity is required."
    }
    if (Object.hasOwn(input, "member_count") && input.member_count !== 0) return "New groups must start with no members."
    const message = validateOutlookGroupFields(input as Partial<OutlookGroupFields>, "create")
    if (message) return message
  }
  return null
}
