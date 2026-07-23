import { createHash } from "node:crypto"

type SupabaseErrorLike = {
  code?: string
  message?: string
  details?: string
}

export class EmailTemplateConflictError extends Error {
  readonly code = "EMAIL_TEMPLATE_CONFLICT"

  constructor(message = "This Outlook template changed after you opened it. Reload Outlook Templates and try again.") {
    super(message)
    this.name = "EmailTemplateConflictError"
  }
}

export function computeEmailTemplateLibraryRevision(
  templates: Array<{ id: string; revision: number }>,
) {
  const revisionText = templates
    .map((template) => ({
      encodedId: Buffer.from(template.id, "utf8").toString("base64"),
      revision: template.revision,
    }))
    .sort((left, right) => (
      left.encodedId < right.encodedId ? -1 : left.encodedId > right.encodedId ? 1 : 0
    ))
    .map((template) => `${template.encodedId}:${template.revision}`)
    .join("\n")

  return createHash("sha256").update(revisionText, "utf8").digest("hex")
}

export function isEmailTemplateConflict(error: unknown) {
  const candidate = (error || {}) as SupabaseErrorLike
  const message = `${candidate.message || ""} ${candidate.details || ""}`.toUpperCase()
  return candidate.code === "40001" ||
    candidate.code === "23505" ||
    message.includes("EMAIL_TEMPLATE_CONFLICT")
}
