import type { EmailTemplate } from "@/lib/emailTemplates"

const EDIT_FIELDS = ["title", "subject", "folder", "sourcePath", "from", "to", "cc", "bcc", "bodyHtml", "bodyText", "tags", "slug", "isActive", "placeholders"] as const

/** Reapply only the user's changed fields; retain unrelated colleague edits. */
export function reapplyEmailTemplateDraft(base: EmailTemplate, draft: EmailTemplate, server: EmailTemplate): EmailTemplate {
  if (base.id !== draft.id || draft.id !== server.id || !Number.isSafeInteger(server.revision) || server.revision < 1) {
    throw new Error("The current server template could not be verified. Your draft is still here.")
  }
  const changes = Object.fromEntries(EDIT_FIELDS.filter(field => JSON.stringify(draft[field]) !== JSON.stringify(base[field])).map(field => [field, draft[field]]))
  const recipientsChanged = (["to", "cc", "bcc"] as const).some(field => field in changes && changes[field] !== server[field])
  return { ...server, ...changes, recipientResolution: recipientsChanged ? {} : server.recipientResolution }
}
