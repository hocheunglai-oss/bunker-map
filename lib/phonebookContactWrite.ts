import { validPhonebookCompanyVersion } from "./phonebookCompanySave"

// Undo restores editable data, never an old row identity or revision. Keep the
// exact server timestamp string for comparisons; JS Dates discard microseconds.
export const validPhonebookContactVersion = validPhonebookCompanyVersion

export const PHONEBOOK_CONTACT_FIELDS = [
  "full_name", "company", "company_source_id", "title", "name_remark", "position", "department", "tel_ext", "direct_line", "mobile_area", "mobile_1", "mobile_2", "personal_email", "general_email", "private_email", "instant_messaging", "others", "area_of_responsibility", "mobile_phone", "pager", "business_phone", "business_phone_2", "other_phone", "email_1", "email_2", "notes", "favorite", "search_text",
] as const

export function phonebookContactUndoPatch(value: Record<string, unknown>) {
  return Object.fromEntries(PHONEBOOK_CONTACT_FIELDS.filter((field) => field in value).map((field) => [field, value[field]]))
}

export function verifiedPhonebookContactRow(value: unknown, expectedId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.id === expectedId && typeof row.full_name === "string" && typeof row.favorite === "boolean" && validPhonebookContactVersion(row.updated_at)
}

export function phonebookContactReadResult(value: unknown, expectedId: string) {
  if (!Array.isArray(value) || value.length > 1) return { kind: "unverified" as const }
  if (value.length === 0) return { kind: "missing" as const }
  return verifiedPhonebookContactRow(value[0], expectedId)
    ? { kind: "contact" as const, contact: value[0] as Record<string, unknown> }
    : { kind: "unverified" as const }
}

export const PHONEBOOK_CONTACT_ARCHIVE_CONFLICT = "This contact changed or was removed. It has not been archived; refresh the directory before trying again."
export const PHONEBOOK_CONTACT_SAVE_CONFLICT = "This contact changed or no longer exists. Your changes have not been saved; refresh the directory before trying again."
export const PHONEBOOK_CONTACT_UNDO_CONFLICT = "This contact changed or was removed. Nothing was undone; refresh the directory and check the latest details."
export const PHONEBOOK_CONTACT_OLD_UNDO = "This older change cannot be safely undone here. Reopen the contact and make the correction manually."
