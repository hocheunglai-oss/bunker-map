import { createClient } from "@supabase/supabase-js"
import { requireAdminSession as requireSharedAdminSession } from "@/lib/adminAuth"
import {
  createAdminAuditedSupabaseClient,
  type AdminAuditContext,
} from "@/lib/adminAudit"
import {
  findTemplateFormattingIssues,
  sanitizeEmailTemplate,
} from "@/lib/emailTemplateSanitizer"
import {
  loadOutlookTemplateRecipientResolver,
  type OutlookTemplateRecipientResolution,
} from "@/lib/outlookTemplateRecipientResolver"
import {
  computeEmailTemplateLibraryRevision,
  EmailTemplateConflictError,
  isEmailTemplateConflict,
} from "@/lib/emailTemplateCanonicalUtils"

export {
  computeEmailTemplateLibraryRevision,
  EmailTemplateConflictError,
  isEmailTemplateConflict,
} from "@/lib/emailTemplateCanonicalUtils"

export type EmailTemplate = {
  id: string
  title: string
  subject: string
  folder: string
  sourcePath: string
  from: string
  to: string
  cc: string
  bcc: string
  bodyHtml: string
  bodyText: string
  tags: string[]
  slug: string
  isActive: boolean
  placeholders: string[]
  recipientResolution: Record<string, unknown>
  updatedAt: string
  revision: number
}

export type EmailTemplateLibrary = {
  templates: EmailTemplate[]
  lastImportedAt: string | null
  lastUpdatedAt: string | null
  revision: string
}

export type EmailTemplateIndexItem = Pick<
  EmailTemplate,
  "id" | "title" | "subject" | "folder" | "to" | "cc" | "bcc" | "isActive" | "updatedAt" | "revision"
>

export type EmailTemplateFormattingRepairResult = {
  scanned: number
  changed: number
  issueCounts: Record<string, number>
  changedTemplates: Array<{
    id: string
    folder: string
    subject: string
    issues: string[]
  }>
}

type EmailTemplateWriteOptions = {
  expectedRevision?: number | null
  expectedUpdatedAt?: string | null
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseClient(auditContext?: AdminAuditContext) {
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")

  if (auditContext) {
    return createAdminAuditedSupabaseClient(auditContext, {
      useServiceRole: true,
    })
  }

  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  )
}

export async function requireAdminSession() {
  return requireSharedAdminSession()
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

export function extractPlaceholders(...values: string[]) {
  const found = new Set<string>()

  for (const value of values) {
    const matches = value.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)
    for (const match of matches) {
      const token = (match[1] || "").trim()
      if (token) found.add(token)
    }
  }

  return Array.from(found).sort((a, b) => a.localeCompare(b))
}

function normaliseTemplate(template: EmailTemplate): EmailTemplate {
  const sanitized = sanitizeEmailTemplate(template) as EmailTemplate

  return {
    ...sanitized,
    placeholders: extractPlaceholders(sanitized.subject || "", sanitized.bodyHtml || "", sanitized.bodyText || ""),
    slug: sanitized.slug || slugify(`${sanitized.folder}-${sanitized.title}`) || sanitized.id,
    isActive: sanitized.isActive !== false,
    recipientResolution:
      sanitized.recipientResolution &&
      typeof sanitized.recipientResolution === "object" &&
      !Array.isArray(sanitized.recipientResolution)
        ? sanitized.recipientResolution
        : {},
  }
}

function asPreviousRecipientResolution(
  value: Record<string, unknown>,
): OutlookTemplateRecipientResolution | null {
  const candidate = value as Partial<OutlookTemplateRecipientResolution>
  return (
    candidate.schema === "fcuno.outlook-template-recipient-resolution/v1" &&
    Boolean(candidate.refs) &&
    Array.isArray(candidate.refs?.to) &&
    Array.isArray(candidate.refs?.cc) &&
    Array.isArray(candidate.refs?.bcc)
  )
    ? (candidate as OutlookTemplateRecipientResolution)
    : null
}

function templateNeedsFormattingRepair(before: EmailTemplate, after: EmailTemplate) {
  return (
    before.subject !== after.subject ||
    before.to !== after.to ||
    before.cc !== after.cc ||
    before.bcc !== after.bcc ||
    before.bodyHtml !== after.bodyHtml ||
    before.bodyText !== after.bodyText
  )
}

function normaliseTemplateBatch(templates: EmailTemplate[]) {
  const normalised = templates.map((template) => normaliseTemplate(template))
  const ids = new Set<string>()
  const slugs = new Set<string>()

  for (const template of normalised) {
    if (!template.id.trim() || !template.title.trim() || !template.slug.trim()) {
      throw new Error("Each Outlook template requires an id, title and slug.")
    }
    if (ids.has(template.id)) {
      throw new Error(`Duplicate Outlook template id: ${template.id}`)
    }
    if (slugs.has(template.slug)) {
      throw new Error(`Duplicate Outlook template slug: ${template.slug}`)
    }
    ids.add(template.id)
    slugs.add(template.slug)
  }

  return normalised
}

function templateToRpcInput(template: EmailTemplate) {
  return {
    id: template.id,
    title: template.title,
    subject: template.subject,
    folder: template.folder,
    source_path: template.sourcePath,
    sender: template.from,
    to_recipients: template.to,
    cc_recipients: template.cc,
    bcc_recipients: template.bcc,
    body_html: template.bodyHtml,
    body_text: template.bodyText,
    tags: template.tags,
    slug: template.slug,
    is_active: template.isActive,
    placeholders: template.placeholders,
    recipient_resolution: template.recipientResolution || {},
  }
}

function throwTemplateWriteError(
  error: unknown,
  message = "This Outlook template changed after you opened it. Reload Outlook Templates and try again."
): never {
  if (isEmailTemplateConflict(error)) {
    throw new EmailTemplateConflictError(message)
  }
  throw error
}

function rowToTemplateRaw(row: any): EmailTemplate {
  return {
    id: row.id,
    title: row.title || "",
    subject: row.subject || "",
    folder: row.folder || "",
    sourcePath: row.source_path || "",
    from: row.sender || "",
    to: row.to_recipients || "",
    cc: row.cc_recipients || "",
    bcc: row.bcc_recipients || "",
    bodyHtml: row.body_html || "",
    bodyText: row.body_text || "",
    tags: Array.isArray(row.tags) ? row.tags : [],
    slug: row.slug || "",
    isActive: row.is_active !== false,
    placeholders: Array.isArray(row.placeholders) ? row.placeholders : [],
    recipientResolution:
      row.recipient_resolution &&
      typeof row.recipient_resolution === "object" &&
      !Array.isArray(row.recipient_resolution)
        ? row.recipient_resolution
        : {},
    updatedAt: row.updated_at || new Date().toISOString(),
    revision: Math.max(Number(row.revision || 0), 0),
  }
}

function rowToTemplate(row: any): EmailTemplate {
  return normaliseTemplate(rowToTemplateRaw(row))
}

function rowToTemplateIndexItem(row: any): EmailTemplateIndexItem {
  const sanitized = sanitizeEmailTemplate({
    subject: row.subject || "",
    to: row.to_recipients || "",
    cc: row.cc_recipients || "",
    bcc: row.bcc_recipients || "",
  })

  return {
    id: row.id,
    title: row.title || "",
    subject: sanitized.subject || "",
    folder: row.folder || "",
    to: sanitized.to || "",
    cc: sanitized.cc || "",
    bcc: sanitized.bcc || "",
    isActive: row.is_active !== false,
    updatedAt: row.updated_at || new Date().toISOString(),
    revision: Math.max(Number(row.revision || 0), 0),
  }
}

export async function loadTemplateLibrary(): Promise<EmailTemplateLibrary> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .order("folder", { ascending: true })
    .order("title", { ascending: true })

  if (error) throw error

  const templates = (data || []).map(rowToTemplate)
  const lastImportedAt = templates.reduce<string | null>(
    (latest, template) => (!latest || template.updatedAt > latest ? template.updatedAt : latest),
    null
  )

  return {
    templates,
    lastImportedAt,
    lastUpdatedAt: lastImportedAt,
    revision: computeEmailTemplateLibraryRevision(templates),
  }
}

export async function loadTemplateIndex(): Promise<{
  templates: EmailTemplateIndexItem[]
  lastImportedAt: string | null
  lastUpdatedAt: string | null
  revision: string
}> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from("email_templates")
    .select("id,title,subject,folder,to_recipients,cc_recipients,bcc_recipients,is_active,updated_at,revision")
    .order("folder", { ascending: true })
    .order("title", { ascending: true })

  if (error) throw error

  const templates = (data || []).map(rowToTemplateIndexItem)
  const lastUpdatedAt = templates.reduce<string | null>(
    (latest, template) => (!latest || template.updatedAt > latest ? template.updatedAt : latest),
    null
  )

  return {
    templates,
    lastImportedAt: lastUpdatedAt,
    lastUpdatedAt,
    revision: computeEmailTemplateLibraryRevision(templates),
  }
}

export async function loadEmailTemplate(id: string): Promise<EmailTemplate | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (error) throw error

  return data ? rowToTemplate(data) : null
}

export async function saveTemplateLibrary(
  library: EmailTemplateLibrary,
  auditContext?: AdminAuditContext
) {
  const supabase = getSupabaseClient(auditContext)
  const templates = normaliseTemplateBatch(library.templates)
  const recipientResolver = await loadOutlookTemplateRecipientResolver()
  const templatesWithCertifiedRecipients = templates.map((template) => ({
    ...template,
    recipientResolution: recipientResolver.resolve({
      to: template.to,
      cc: template.cc,
      bcc: template.bcc,
    }, asPreviousRecipientResolution(template.recipientResolution)),
  }))

  if (!/^[0-9a-f]{64}$/.test(library.revision || "")) {
    throw new EmailTemplateConflictError(
      "The Outlook template library version is missing. Reload Outlook Templates before replacing the library."
    )
  }

  const { data, error } = await supabase.rpc(
    "replace_email_template_library_canonical",
    {
      p_templates: templatesWithCertifiedRecipients.map((template) => templateToRpcInput(template)),
      p_expected_library_revision: library.revision,
    }
  )

  if (error) {
    throwTemplateWriteError(
      error,
      "The Outlook template library changed while it was being saved. Reload Outlook Templates and try again."
    )
  }

  const result = (data || {}) as {
    templates?: unknown[]
    lastImportedAt?: string | null
    lastUpdatedAt?: string | null
    revision?: string
  }
  const savedTemplates = Array.isArray(result.templates)
    ? result.templates.map(rowToTemplate)
    : []

  return {
    templates: savedTemplates,
    lastImportedAt: result.lastImportedAt ?? null,
    lastUpdatedAt: result.lastUpdatedAt ?? null,
    revision: result.revision || computeEmailTemplateLibraryRevision(savedTemplates),
  } satisfies EmailTemplateLibrary
}

export async function saveEmailTemplate(
  template: EmailTemplate,
  auditContext?: AdminAuditContext,
  options: EmailTemplateWriteOptions = {}
) {
  const supabase = getSupabaseClient(auditContext)
  const nextTemplate = normaliseTemplate(template)
  const recipientResolver = await loadOutlookTemplateRecipientResolver()
  const nextTemplateWithCertifiedRecipients = {
    ...nextTemplate,
    recipientResolution: recipientResolver.resolve({
      to: nextTemplate.to,
      cc: nextTemplate.cc,
      bcc: nextTemplate.bcc,
    }, asPreviousRecipientResolution(nextTemplate.recipientResolution)),
  }
  const expectedRevision = options.expectedRevision === undefined
    ? (nextTemplate.revision > 0 ? nextTemplate.revision : null)
    : options.expectedRevision
  const expectedUpdatedAt = options.expectedUpdatedAt === undefined
    ? (expectedRevision ? null : nextTemplate.updatedAt || null)
    : options.expectedUpdatedAt
  const { data, error } = await supabase.rpc(
    "save_email_template_canonical",
    {
      p_template: templateToRpcInput(nextTemplateWithCertifiedRecipients),
      p_expected_revision: expectedRevision,
      p_expected_updated_at: expectedUpdatedAt,
    }
  )

  if (error) {
    throwTemplateWriteError(error)
  }

  return rowToTemplate(data)
}

export async function deleteEmailTemplate(
  id: string,
  auditContext?: AdminAuditContext,
  options: EmailTemplateWriteOptions = {}
) {
  const supabase = getSupabaseClient(auditContext)
  const { error } = await supabase.rpc(
    "delete_email_template_canonical",
    {
      p_id: id,
      p_expected_revision: options.expectedRevision ?? null,
      p_expected_updated_at: options.expectedUpdatedAt ?? null,
    }
  )

  if (error) {
    throwTemplateWriteError(
      error,
      "This Outlook template changed before it could be deleted. Reload Outlook Templates and try again."
    )
  }
}

export async function repairEmailTemplateFormatting(
  auditContext?: AdminAuditContext
): Promise<EmailTemplateFormattingRepairResult> {
  const supabase = getSupabaseClient(auditContext)
  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .order("folder", { ascending: true })
    .order("title", { ascending: true })

  if (error) throw error

  const rawTemplates = Array.isArray(data) ? data.map(rowToTemplateRaw) : []
  const issueCounts: Record<string, number> = {}
  const changedTemplates: EmailTemplateFormattingRepairResult["changedTemplates"] = []

  const repairs: Array<Record<string, unknown>> = []
  const recipientResolver = await loadOutlookTemplateRecipientResolver()

  rawTemplates.forEach((template) => {
    const issues = findTemplateFormattingIssues(template)
    for (const issue of issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1

    const repaired = normaliseTemplate({
      ...template,
      updatedAt: template.updatedAt || new Date().toISOString(),
    })

    if (!templateNeedsFormattingRepair(template, repaired)) return

    changedTemplates.push({
      id: template.id,
      folder: template.folder,
      subject: template.subject,
      issues,
    })
    repairs.push({
      ...templateToRpcInput({
        ...repaired,
        recipientResolution: recipientResolver.resolve({
          to: repaired.to,
          cc: repaired.cc,
          bcc: repaired.bcc,
        }, asPreviousRecipientResolution(template.recipientResolution)),
      }),
      expected_revision: template.revision,
    })
  })

  if (repairs.length > 0) {
    const { error: repairError } = await supabase.rpc(
      "repair_email_templates_canonical",
      { p_repairs: repairs }
    )
    if (repairError) {
      throwTemplateWriteError(
        repairError,
        "One or more Outlook templates changed during formatting repair. Reload and run the repair again."
      )
    }
  }

  return {
    scanned: rawTemplates.length,
    changed: changedTemplates.length,
    issueCounts,
    changedTemplates,
  }
}
