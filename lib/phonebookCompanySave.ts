export const PHONEBOOK_COMPANY_FIELDS = [
  "name", "other_name", "phone", "address", "country", "tel_country", "tel_area", "tel_no_1", "tel_no_2", "tel_speed_dial", "fax_no_1", "website", "email", "contact_type", "stem_management", "company_status", "company_info", "seller_term", "seller_credit_limit", "seller_credit_limit_flexibility", "seller_classification", "seller_remark_1", "seller_remark_2", "seller_remark_3", "seller_remark_4", "buyer_term", "buyer_credit_limit", "buyer_credit_limit_flexibility", "buyer_classification", "buyer_remark_1", "buyer_remark_2", "buyer_remark_3", "buyer_remark_4", "notes",
] as const

export const PHONEBOOK_COMPANY_CONFLICT = "This company changed or was removed. Your edits are still here; reopen it before saving again."
export const PHONEBOOK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function phonebookCompanyPatch(value: Record<string, unknown>) {
  return Object.fromEntries(PHONEBOOK_COMPANY_FIELDS.filter((key) => key in value).map((key) => [key, value[key]]))
}

export function validPhonebookCompanyVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
}

export function validatePhonebookCompanySave(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((key) => !["id", "expectedUpdatedAt", "patch"].includes(key))
    || typeof body.id !== "string" || !PHONEBOOK_UUID.test(body.id) || !validPhonebookCompanyVersion(body.expectedUpdatedAt)
    || !body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) return null
  const patch = body.patch as Record<string, unknown>
  if (Object.keys(patch).some((key) => !(PHONEBOOK_COMPANY_FIELDS as readonly string[]).includes(key))
    || Object.values(patch).some((field) => field !== null && (typeof field !== "string" || field.length > 20_000 || /\u0000/.test(field)))
    || typeof patch.name !== "string") return null
  const name = patch.name.trim().toUpperCase()
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null
  return { id: body.id.toLowerCase(), expectedUpdatedAt: body.expectedUpdatedAt, patch: { ...patch, name } }
}
