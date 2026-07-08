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

const LEGACY_STORE_KEY = "email-templates"

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
  updatedAt: string
}

export type EmailTemplateLibrary = {
  templates: EmailTemplate[]
  lastImportedAt: string | null
  lastUpdatedAt: string | null
}

export type EmailTemplateIndexItem = Pick<
  EmailTemplate,
  "id" | "title" | "subject" | "folder" | "to" | "cc" | "bcc" | "isActive" | "updatedAt"
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

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseClient(auditContext?: AdminAuditContext) {
  if (auditContext) {
    return createAdminAuditedSupabaseClient(auditContext, {
      useServiceRole: true,
    })
  }

  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  )
}

function createEmptyLibrary(): EmailTemplateLibrary {
  return {
    templates: [],
    lastImportedAt: null,
    lastUpdatedAt: null,
  }
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
  }
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

function ensureUniqueSlugs(templates: EmailTemplate[]) {
  const seen = new Map<string, number>()

  return templates.map((template) => {
    const baseSlug = template.slug || slugify(`${template.folder}-${template.title}`) || template.id
    const seenCount = seen.get(baseSlug) || 0
    seen.set(baseSlug, seenCount + 1)

    return {
      ...template,
      slug: seenCount === 0 ? baseSlug : `${baseSlug}-${seenCount + 1}`,
    }
  })
}

function ensureUniqueIds(templates: EmailTemplate[]) {
  const seen = new Map<string, number>()

  return templates.map((template) => {
    const baseId = template.id || slugify(`${template.folder}-${template.title}`) || `template-${Date.now()}`
    const seenCount = seen.get(baseId) || 0
    seen.set(baseId, seenCount + 1)

    return {
      ...template,
      id: seenCount === 0 ? baseId : `${baseId}-${seenCount + 1}`,
    }
  })
}

function templateToRow(template: EmailTemplate) {
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
    updated_at: template.updatedAt,
  }
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
    updatedAt: row.updated_at || new Date().toISOString(),
  }
}

function rowToTemplate(row: any): EmailTemplate {
  return normaliseTemplate(rowToTemplateRaw(row))
}

function rowToTemplateIndexItem(row: any): EmailTemplateIndexItem {
  return {
    id: row.id,
    title: row.title || "",
    subject: row.subject || "",
    folder: row.folder || "",
    to: row.to_recipients || "",
    cc: row.cc_recipients || "",
    bcc: row.bcc_recipients || "",
    isActive: row.is_active !== false,
    updatedAt: row.updated_at || new Date().toISOString(),
  }
}

function templateToIndexItem(template: EmailTemplate): EmailTemplateIndexItem {
  return {
    id: template.id,
    title: template.title,
    subject: template.subject,
    folder: template.folder,
    to: template.to,
    cc: template.cc,
    bcc: template.bcc,
    isActive: template.isActive,
    updatedAt: template.updatedAt,
  }
}

async function loadLegacyLibrary(supabase: any): Promise<EmailTemplateLibrary> {
  const legacyStore = (supabase as any).from("office_calendar_store")
  const { data, error } = await legacyStore
    .select("payload")
    .eq("key", LEGACY_STORE_KEY)
    .maybeSingle()

  if (error) throw error

  const payload = (((data as { payload?: unknown } | null)?.payload) || createEmptyLibrary()) as Partial<EmailTemplateLibrary>
  const templates = Array.isArray(payload.templates)
    ? payload.templates.map((template) => normaliseTemplate(template as EmailTemplate))
    : []

  return {
    templates,
    lastImportedAt: payload.lastImportedAt ?? null,
    lastUpdatedAt: payload.lastUpdatedAt ?? null,
  }
}

async function saveLegacyLibrary(supabase: any, library: EmailTemplateLibrary) {
  const { error } = await (supabase as any).from("office_calendar_store").upsert({
    key: LEGACY_STORE_KEY,
    payload: library,
    updated_at: new Date().toISOString(),
  })

  if (error) throw error
}

export async function loadTemplateLibrary(): Promise<EmailTemplateLibrary> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .order("folder", { ascending: true })
    .order("title", { ascending: true })

  if (error) {
    const message = String(error.message || "")
    if (message.toLowerCase().includes("relation") || message.toLowerCase().includes("does not exist")) {
      return loadLegacyLibrary(supabase)
    }
    throw error
  }

  if (!data || data.length === 0) {
    return loadLegacyLibrary(supabase)
  }

  const templates = data.map(rowToTemplate)

  const uniqueTemplates = ensureUniqueSlugs(ensureUniqueIds(templates))

  const lastImportedAt = uniqueTemplates.reduce<string | null>(
    (latest, template) => (!latest || template.updatedAt > latest ? template.updatedAt : latest),
    null
  )

  return {
    templates: uniqueTemplates,
    lastImportedAt,
    lastUpdatedAt: lastImportedAt,
  }
}

export async function loadTemplateIndex(): Promise<{
  templates: EmailTemplateIndexItem[]
  lastImportedAt: string | null
  lastUpdatedAt: string | null
}> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from("email_templates")
    .select("id,title,subject,folder,to_recipients,cc_recipients,bcc_recipients,is_active,updated_at")
    .order("folder", { ascending: true })
    .order("title", { ascending: true })

  if (error) {
    const message = String(error.message || "")
    if (message.toLowerCase().includes("relation") || message.toLowerCase().includes("does not exist")) {
      const library = await loadLegacyLibrary(supabase)
      const templates = library.templates.map(templateToIndexItem)
      return { templates, lastImportedAt: library.lastImportedAt, lastUpdatedAt: library.lastUpdatedAt }
    }
    throw error
  }

  if (!data || data.length === 0) {
    const library = await loadLegacyLibrary(supabase)
    const templates = library.templates.map(templateToIndexItem)
    return { templates, lastImportedAt: library.lastImportedAt, lastUpdatedAt: library.lastUpdatedAt }
  }

  const templates = data.map(rowToTemplateIndexItem)
  const lastUpdatedAt = templates.reduce<string | null>(
    (latest, template) => (!latest || template.updatedAt > latest ? template.updatedAt : latest),
    null
  )

  return { templates, lastImportedAt: lastUpdatedAt, lastUpdatedAt }
}

export async function loadEmailTemplate(id: string): Promise<EmailTemplate | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (error) {
    const message = String(error.message || "")
    if (message.toLowerCase().includes("relation") || message.toLowerCase().includes("does not exist")) {
      const library = await loadLegacyLibrary(supabase)
      return library.templates.find((template) => template.id === id) || null
    }
    throw error
  }

  return data ? rowToTemplate(data) : null
}

export async function saveTemplateLibrary(
  library: EmailTemplateLibrary,
  auditContext?: AdminAuditContext
) {
  const supabase = getSupabaseClient(auditContext)
  const templates = ensureUniqueSlugs(ensureUniqueIds(library.templates.map((template) => normaliseTemplate(template))))

  const { error: wipeError } = await supabase.from("email_templates").delete().neq("id", "")
  if (wipeError) {
    const message = String(wipeError.message || "")
    if (message.toLowerCase().includes("relation") || message.toLowerCase().includes("does not exist")) {
      await saveLegacyLibrary(supabase, { ...library, templates })
      return
    }
    throw wipeError
  }

  if (templates.length === 0) return

  const { error } = await supabase.from("email_templates").insert(
    templates.map((template) => templateToRow(template))
  )

  if (error) {
    const message = String(error.message || "")
    if (message.toLowerCase().includes("relation") || message.toLowerCase().includes("does not exist")) {
      await saveLegacyLibrary(supabase, { ...library, templates })
      return
    }
    throw error
  }
}

export async function saveEmailTemplate(
  template: EmailTemplate,
  auditContext?: AdminAuditContext
) {
  const supabase = getSupabaseClient(auditContext)
  const nextTemplate = normaliseTemplate(template)
  const { error } = await supabase
    .from("email_templates")
    .upsert(templateToRow(nextTemplate), { onConflict: "id" })

  if (error) {
    const message = String(error.message || "")
    if (message.toLowerCase().includes("relation") || message.toLowerCase().includes("does not exist")) {
      const library = await loadLegacyLibrary(supabase)
      const templates = library.templates.some((item) => item.id === nextTemplate.id)
        ? library.templates.map((item) => (item.id === nextTemplate.id ? nextTemplate : item))
        : [nextTemplate, ...library.templates]

      await saveLegacyLibrary(supabase, {
        ...library,
        templates,
        lastUpdatedAt: nextTemplate.updatedAt,
      })
      return nextTemplate
    }
    throw error
  }

  return nextTemplate
}

export async function deleteEmailTemplate(
  id: string,
  auditContext?: AdminAuditContext
) {
  const supabase = getSupabaseClient(auditContext)
  const { error } = await supabase.from("email_templates").delete().eq("id", id)

  if (error) {
    const message = String(error.message || "")
    if (message.toLowerCase().includes("relation") || message.toLowerCase().includes("does not exist")) {
      const library = await loadLegacyLibrary(supabase)
      await saveLegacyLibrary(supabase, {
        ...library,
        templates: library.templates.filter((template) => template.id !== id),
        lastUpdatedAt: new Date().toISOString(),
      })
      return
    }
    throw error
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

  if (error) {
    const message = String(error.message || "")
    if (message.toLowerCase().includes("relation") || message.toLowerCase().includes("does not exist")) {
      const library = await loadLegacyLibrary(supabase)
      return repairLegacyEmailTemplateFormatting(supabase, library)
    }
    throw error
  }

  const rawTemplates = Array.isArray(data) ? data.map(rowToTemplateRaw) : []
  const issueCounts: Record<string, number> = {}
  const changedTemplates: EmailTemplateFormattingRepairResult["changedTemplates"] = []

  const templates = rawTemplates.map((template) => {
    const issues = findTemplateFormattingIssues(template)
    for (const issue of issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1

    const repaired = normaliseTemplate({
      ...template,
      updatedAt: template.updatedAt || new Date().toISOString(),
    })

    if (!templateNeedsFormattingRepair(template, repaired)) return template

    changedTemplates.push({
      id: template.id,
      folder: template.folder,
      subject: template.subject,
      issues,
    })

    return {
      ...repaired,
      updatedAt: new Date().toISOString(),
    }
  })

  if (changedTemplates.length > 0) {
    await saveTemplateLibrary(
      {
        templates,
        lastUpdatedAt: new Date().toISOString(),
        lastImportedAt: templates.reduce<string | null>(
          (latest, template) => (!latest || template.updatedAt > latest ? template.updatedAt : latest),
          null
        ),
      },
      auditContext
    )
  }

  return {
    scanned: rawTemplates.length,
    changed: changedTemplates.length,
    issueCounts,
    changedTemplates,
  }
}

async function repairLegacyEmailTemplateFormatting(
  supabase: any,
  library: EmailTemplateLibrary
): Promise<EmailTemplateFormattingRepairResult> {
  const issueCounts: Record<string, number> = {}
  const changedTemplates: EmailTemplateFormattingRepairResult["changedTemplates"] = []

  const templates = library.templates.map((template) => {
    const issues = findTemplateFormattingIssues(template)
    for (const issue of issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1
    const repaired = normaliseTemplate(template)
    if (!templateNeedsFormattingRepair(template, repaired)) return template
    changedTemplates.push({
      id: template.id,
      folder: template.folder,
      subject: template.subject,
      issues,
    })
    return {
      ...repaired,
      updatedAt: new Date().toISOString(),
    }
  })

  if (changedTemplates.length > 0) {
    await saveLegacyLibrary(supabase, {
      ...library,
      templates,
      lastUpdatedAt: new Date().toISOString(),
    })
  }

  return {
    scanned: library.templates.length,
    changed: changedTemplates.length,
    issueCounts,
    changedTemplates,
  }
}
