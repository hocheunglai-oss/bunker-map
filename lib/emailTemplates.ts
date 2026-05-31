import { cookies } from "next/headers"
import { createClient } from "@supabase/supabase-js"
import fs from "node:fs/promises"
import path from "node:path"

const ADMIN_COOKIE_NAME = "bunker_admin_auth"
const LEGACY_STORE_KEY = "email-templates"
const THUNDERBIRD_ROOT = "/Users/hocheunglai/Desktop/- Thunderbird Templates/Templates.sbd"

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

type ThunderbirdTemplate = Omit<EmailTemplate, "id" | "updatedAt" | "slug" | "isActive" | "placeholders">

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getSupabaseClient() {
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
  const cookieStore = await cookies()
  if (cookieStore.get(ADMIN_COOKIE_NAME)?.value !== "1") {
    throw new Error("Unauthorized")
  }
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function normaliseNewlines(input: string) {
  return input.replace(/\r\n/g, "\n")
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
}

function getHeaderValue(headers: string, name: string) {
  const target = name.toLowerCase()
  let currentName = ""
  let currentValue: string[] = []

  function flush() {
    if (currentName.toLowerCase() !== target) return ""
    return decodeHtmlEntities(currentValue.join(" ").replace(/\s+/g, " ").trim())
  }

  for (const line of normaliseNewlines(headers).split("\n")) {
    if (/^[ \t]/.test(line) && currentName) {
      currentValue.push(line.trim())
      continue
    }

    const value = flush()
    if (value) return value

    const colonIndex = line.indexOf(":")
    if (colonIndex <= 0) {
      currentName = ""
      currentValue = []
      continue
    }
    currentName = line.slice(0, colonIndex).trim()
    currentValue = [line.slice(colonIndex + 1).trim()]
  }

  return flush()
}

function extractBody(rawMessage: string) {
  const normalised = normaliseNewlines(rawMessage)
  const dividerIndex = normalised.indexOf("\n\n")

  if (dividerIndex === -1) {
    return { headers: normalised, body: "" }
  }

  return {
    headers: normalised.slice(0, dividerIndex),
    body: normalised.slice(dividerIndex + 2).trim(),
  }
}

function htmlToText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .trim()
  )
}

function splitMboxMessages(rawFile: string) {
  const normalised = normaliseNewlines(rawFile).trim()
  if (!normalised) return []

  const lines = normalised.split("\n")
  const messages: string[] = []
  let current: string[] = []

  for (const line of lines) {
    if (/^From - /.test(line) && current.length > 0) {
      messages.push(current.join("\n"))
      current = [line]
      continue
    }
    current.push(line)
  }

  if (current.length > 0) messages.push(current.join("\n"))
  return messages
}

async function walkTemplateFiles(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    if (entry.name.endsWith(".msf")) continue
    if (entry.name === "msgFilterRules.dat") continue
    if (/^nstmp/i.test(entry.name)) continue

    const fullPath = path.join(directoryPath, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await walkTemplateFiles(fullPath)))
      continue
    }

    if (entry.isFile()) files.push(fullPath)
  }

  return files
}

function buildFolderLabel(filePath: string) {
  const relative = path.relative(THUNDERBIRD_ROOT, filePath)
  return relative
    .split(path.sep)
    .map((part) => part.replace(/\.sbd$/i, ""))
    .filter(Boolean)
    .join(" / ")
}

function buildTemplateId(template: ThunderbirdTemplate, sequence: number) {
  const parts = [
    template.folder || "root",
    path.basename(template.sourcePath),
    template.title || `template-${sequence + 1}`,
    String(sequence + 1),
  ]

  return slugify(parts.join("-")) || `template-${sequence + 1}`
}

function normaliseTemplateFolderParts(folder: string) {
  return (folder || "")
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean)
}

function shouldSkipImportedFolder(folder: string) {
  const parts = normaliseTemplateFolderParts(folder)
  if (folder.startsWith("Internal / Outgoing")) return true

  return parts.some((part) => {
    if (["Drafts", "Trash", "Unsent Messages", "!Retired"].includes(part)) return true
    if (/^nstmp/i.test(part)) return true
    return /\((backup|temp)\)/i.test(part)
  })
}

function normaliseDedupValue(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function templateDedupKey(template: Pick<EmailTemplate, "subject" | "to" | "cc" | "bcc" | "bodyHtml">) {
  return [template.subject, template.to, template.cc, template.bcc, template.bodyHtml]
    .map(normaliseDedupValue)
    .join("\u0001")
}

function templateFolderPreference(template: Pick<EmailTemplate, "folder">) {
  const folder = template.folder || ""
  const depthPenalty = normaliseTemplateFolderParts(folder).length
  let score = 100 - depthPenalty
  if (folder.startsWith("Outgoing")) score += 40
  if (folder.startsWith("Internal")) score += 20
  if (folder.startsWith("FCBV")) score += 10
  return score
}

function deduplicateTemplatesByContent(templates: EmailTemplate[]) {
  const byKey = new Map<string, EmailTemplate>()

  for (const template of templates) {
    const key = templateDedupKey(template)
    const existing = byKey.get(key)
    if (!existing || templateFolderPreference(template) > templateFolderPreference(existing)) {
      byKey.set(key, template)
    }
  }

  return Array.from(byKey.values())
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
  return {
    ...template,
    placeholders: extractPlaceholders(template.subject || "", template.bodyHtml || "", template.bodyText || ""),
    slug: template.slug || slugify(`${template.folder}-${template.title}`) || template.id,
    isActive: template.isActive !== false,
  }
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

function rowToTemplate(row: any): EmailTemplate {
  return normaliseTemplate({
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
  })
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

export async function saveTemplateLibrary(library: EmailTemplateLibrary) {
  const supabase = getSupabaseClient()
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

export async function saveEmailTemplate(template: EmailTemplate) {
  const supabase = getSupabaseClient()
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

export async function deleteEmailTemplate(id: string) {
  const supabase = getSupabaseClient()
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

export async function importThunderbirdTemplates() {
  const templateFiles = await walkTemplateFiles(THUNDERBIRD_ROOT)
  const imported: EmailTemplate[] = []
  let sequence = 0

  for (const filePath of templateFiles) {
    const rawFile = await fs.readFile(filePath, "utf8")
    const messages = splitMboxMessages(rawFile)
    const folder = buildFolderLabel(filePath)
    if (shouldSkipImportedFolder(folder)) continue

    for (const message of messages) {
      const { headers, body } = extractBody(message)
      const subject = getHeaderValue(headers, "Subject")
      const title = subject || `${path.basename(filePath)} ${sequence + 1}`
      const to = getHeaderValue(headers, "To")
      const cc = getHeaderValue(headers, "Cc")
      const bcc = getHeaderValue(headers, "Bcc") || getHeaderValue(headers, "BCC")
      const from = getHeaderValue(headers, "From")
      const bodyHtml = body
      const bodyText = htmlToText(body)
      const tags = folder.split(" / ").map((part) => part.trim()).filter(Boolean)

      const template: ThunderbirdTemplate = {
        title,
        subject,
        folder,
        sourcePath: filePath,
        from,
        to,
        cc,
        bcc,
        bodyHtml,
        bodyText,
        tags,
      }

      imported.push(
        normaliseTemplate({
          ...template,
          id: buildTemplateId(template, sequence),
          slug: slugify(`${folder}-${title}`) || `template-${sequence + 1}`,
          isActive: true,
          placeholders: [],
          updatedAt: new Date().toISOString(),
        })
      )

      sequence += 1
    }
  }

  const deduplicated = deduplicateTemplatesByContent(imported)

  deduplicated.sort((a, b) => {
    const folderCompare = a.folder.localeCompare(b.folder)
    if (folderCompare !== 0) return folderCompare
    return a.title.localeCompare(b.title)
  })

  const uniqueTemplates = ensureUniqueSlugs(ensureUniqueIds(deduplicated))

  const library: EmailTemplateLibrary = {
    templates: uniqueTemplates,
    lastImportedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  }

  await saveTemplateLibrary(library)
  return library
}
