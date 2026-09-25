export type OutlookContactFields = {
  display_name: string
  primary_email: string
  source_book: string
  nickname: string | null
  first_name: string | null
  last_name: string | null
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

export function normalizeOutlookContactFields(input: OutlookContactFields): OutlookContactFields {
  return {
    display_name: cleanText(input.display_name),
    primary_email: input.primary_email.trim().toLowerCase(),
    source_book: cleanText(input.source_book),
    nickname: input.nickname ? cleanText(input.nickname) || null : null,
    first_name: input.first_name ? cleanText(input.first_name) || null : null,
    last_name: input.last_name ? cleanText(input.last_name) || null : null,
  }
}

function isEmailAddress(value: string) {
  const email = value.trim()
  if (email.length > 254) return false
  const parts = email.split("@")
  if (parts.length !== 2) return false
  const [local, domain] = parts
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return false
  }
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false
  const labels = domain.split(".")
  return labels.length >= 2 && labels.every((label) => (
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ))
}

/** Validate only supplied fields for updates, without requiring untouched legacy fields. */
export function validateOutlookContactFields(
  input: Partial<OutlookContactFields>,
  mode: "create" | "update" = "create",
): string | null {
  const has = (field: keyof OutlookContactFields) => Object.prototype.hasOwnProperty.call(input, field)
  for (const [field, label] of [
    ["display_name", "Display name"],
    ["source_book", "Source book"],
  ] as const) {
    if (mode === "create" || has(field)) {
      if (typeof input[field] !== "string" || !input[field].trim()) return `${label} is required.`
    }
  }

  if (mode === "create" || has("primary_email")) {
    if (typeof input.primary_email !== "string" || !isEmailAddress(input.primary_email)) {
      return "Enter one complete, valid email address before saving the contact."
    }
  }

  for (const field of ["nickname", "first_name", "last_name"] as const) {
    if (has(field) && input[field] !== null && typeof input[field] !== "string") {
      return "Contact names must be text."
    }
  }
  return null
}
