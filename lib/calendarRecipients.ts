import { isValidEmailAddress, normalizeEmailList } from "@/lib/emailAddress"

export function validateCalendarEmailList(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 20000) throw new Error("The calendar email list is invalid.")
  const entries = value.split(/[\n,;]+/).map((part) => part.trim()).filter(Boolean)
  for (const entry of entries) {
    const address = entry.match(/^(?:[^<>]*\s)?<([^<>]+)>$/)?.[1]?.trim() || entry
    if (!isValidEmailAddress(address)) throw new Error("One or more email addresses are invalid. Use complete email addresses separated by commas, semicolons or new lines.")
  }
  return normalizeEmailList(value)
}

export function resolveEventCalendarRecipients(payload: Record<string, unknown>, fallback: string | undefined) {
  // Deliberately empty means disabled, not permission to email another list.
  return validateCalendarEmailList(Object.hasOwn(payload, "emailRecipientsText") ? payload.emailRecipientsText : fallback || "")
}
