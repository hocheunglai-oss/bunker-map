import fs from "node:fs/promises"
import path from "node:path"
import { buildOutlookManifest } from "./outlook-manifest.mjs"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const THUNDERBIRD_ROOT = "/Users/hocheunglai/Desktop/- Thunderbird Templates/Templates.sbd"
const MANIFEST_PATH = path.join(process.cwd(), "downloads", "fratelli-cosulich-templates-manifest.xml")
const BASE_URL = process.env.MANIFEST_BASE_URL || "https://localhost:3002"

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Missing Supabase environment variables.")
}

function slugify(input) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
}

function normaliseNewlines(input) {
  return input.replace(/\r\n/g, "\n")
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
}

function getHeaderValue(headers, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(`^${escapedName}:([\\s\\S]*?)(?:\\n[^ \\t]|$)`, "im")
  const match = headers.match(regex)
  if (!match) return ""
  return decodeHtmlEntities(match[1].replace(/\n[ \t]+/g, " ").trim())
}

function extractBody(rawMessage) {
  const normalised = normaliseNewlines(rawMessage)
  const dividerIndex = normalised.indexOf("\n\n")
  if (dividerIndex === -1) return { headers: normalised, body: "" }
  return {
    headers: normalised.slice(0, dividerIndex),
    body: normalised.slice(dividerIndex + 2).trim(),
  }
}

function htmlToText(html) {
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

function extractPlaceholders(...values) {
  const found = new Set()
  for (const value of values) {
    const matches = value.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)
    for (const match of matches) {
      if (match[1]) found.add(match[1].trim())
    }
  }
  return Array.from(found).sort((a, b) => a.localeCompare(b))
}

function splitMboxMessages(rawFile) {
  const normalised = normaliseNewlines(rawFile).trim()
  if (!normalised) return []
  const lines = normalised.split("\n")
  const messages = []
  let current = []
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

async function walkTemplateFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.endsWith(".msf") || entry.name === "msgFilterRules.dat") continue
    const fullPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkTemplateFiles(fullPath)))
      continue
    }
    if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function buildFolderLabel(filePath) {
  const relative = path.relative(THUNDERBIRD_ROOT, filePath)
  return relative
    .split(path.sep)
    .map((part) => part.replace(/\.sbd$/i, ""))
    .filter(Boolean)
    .join(" / ")
}

function ensureUniqueSlugs(templates) {
  const seen = new Map()
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

function ensureUniqueIds(templates) {
  const seen = new Map()
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

async function buildTemplates() {
  const templateFiles = await walkTemplateFiles(THUNDERBIRD_ROOT)
  const templates = []
  let sequence = 0
  for (const filePath of templateFiles) {
    const rawFile = await fs.readFile(filePath, "utf8")
    const messages = splitMboxMessages(rawFile)
    const folder = buildFolderLabel(filePath)
    for (const message of messages) {
      const { headers, body } = extractBody(message)
      const subject = getHeaderValue(headers, "Subject")
      const title = subject || `${path.basename(filePath)} ${sequence + 1}`
      const bodyText = htmlToText(body)
      const template = {
        id: slugify([folder || "root", path.basename(filePath), title, String(sequence + 1)].join("-")) || `template-${sequence + 1}`,
        title,
        subject,
        folder,
        sourcePath: filePath,
        from: getHeaderValue(headers, "From"),
        to: getHeaderValue(headers, "To"),
        cc: getHeaderValue(headers, "Cc"),
        bcc: getHeaderValue(headers, "Bcc") || getHeaderValue(headers, "BCC"),
        bodyHtml: body,
        bodyText,
        tags: folder.split(" / ").map((part) => part.trim()).filter(Boolean),
        slug: slugify(`${folder}-${title}`) || `template-${sequence + 1}`,
        isActive: true,
        placeholders: extractPlaceholders(subject, body, bodyText),
        updatedAt: new Date().toISOString(),
      }
      templates.push(template)
      sequence += 1
    }
  }
  templates.sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title))
  return ensureUniqueSlugs(ensureUniqueIds(templates))
}

async function tryDedicatedTable(templates) {
  const wipe = await fetch(`${SUPABASE_URL}/rest/v1/email_templates?id=not.eq.__never__`, {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  })

  if (!wipe.ok) {
    const text = await wipe.text()
    if (text.includes("relation") || text.includes("does not exist")) return false
    throw new Error(`Dedicated table delete failed: ${wipe.status} ${text}`)
  }

  const rows = templates.map((template) => ({
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
  }))

  const batchSize = 100
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize)
    const insert = await fetch(`${SUPABASE_URL}/rest/v1/email_templates`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
    })

    if (!insert.ok) {
      const text = await insert.text()
      if (text.includes("relation") || text.includes("does not exist")) return false
      throw new Error(`Dedicated table insert failed: ${insert.status} ${text}`)
    }
  }

  return true
}

async function saveLegacyStore(templates) {
  const payload = {
    templates,
    lastImportedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/office_calendar_store`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify([{ key: "email-templates", payload, updated_at: new Date().toISOString() }]),
  })

  if (!response.ok) {
    throw new Error(`Legacy store save failed: ${response.status} ${await response.text()}`)
  }

  return payload
}

const templates = await buildTemplates()
const usedDedicatedTable = await tryDedicatedTable(templates)
const payload = usedDedicatedTable
  ? {
      templates: [],
      lastImportedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    }
  : await saveLegacyStore(templates)

await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true })
await fs.writeFile(MANIFEST_PATH, buildOutlookManifest(BASE_URL), "utf8")

console.log(JSON.stringify({
  templates: templates.length,
  usedDedicatedTable,
  manifestPath: MANIFEST_PATH,
  manifestBaseUrl: BASE_URL,
  lastImportedAt: payload.lastImportedAt,
}, null, 2))
