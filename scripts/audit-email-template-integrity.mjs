import fs from "node:fs/promises"
import path from "node:path"

const THUNDERBIRD_ROOT = process.env.THUNDERBIRD_TEMPLATE_ROOT || "/Users/hocheunglai/Desktop/- Thunderbird Templates/Templates.sbd"
const TEMPLATE_API_URL = process.env.EMAIL_TEMPLATE_API_URL || "https://fcuno.com/api/email-templates"

function slugify(input) {
  return String(input || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
}

function normaliseNewlines(input) {
  return String(input || "").replace(/\r\n/g, "\n")
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
}

function getHeaderValue(headers, name) {
  const target = String(name || "").toLowerCase()
  let currentName = ""
  let currentValue = []

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
    String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .trim()
  )
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
    if (/^nstmp/i.test(entry.name)) continue
    const fullPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) files.push(...(await walkTemplateFiles(fullPath)))
    if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function buildFolderLabel(filePath) {
  return path.relative(THUNDERBIRD_ROOT, filePath)
    .split(path.sep)
    .map((part) => part.replace(/\.sbd$/i, ""))
    .filter(Boolean)
    .join(" / ")
}

function folderParts(folder) {
  return String(folder || "").split(" / ").map((part) => part.trim()).filter(Boolean)
}

function shouldSkipImportedFolder(folder) {
  const parts = folderParts(folder)
  if (String(folder || "").startsWith("Internal / Outgoing")) return true
  return parts.some((part) => {
    if (["Drafts", "Trash", "Unsent Messages", "!Retired"].includes(part)) return true
    if (/^nstmp/i.test(part)) return true
    return /\((backup|temp)\)/i.test(part)
  })
}

function normaliseValue(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim()
}

function templateDedupKey(template) {
  return [template.subject, template.to, template.cc, template.bcc, template.bodyHtml].map(normaliseValue).join("\u0001")
}

function templateFolderPreference(template) {
  const folder = template.folder || ""
  let score = 100 - folderParts(folder).length
  if (folder.startsWith("Outgoing")) score += 40
  if (folder.startsWith("Internal")) score += 20
  if (folder.startsWith("FCBV")) score += 10
  return score
}

function deduplicateTemplatesByContent(templates) {
  const byKey = new Map()
  for (const template of templates) {
    const key = templateDedupKey(template)
    const existing = byKey.get(key)
    if (!existing || templateFolderPreference(template) > templateFolderPreference(existing)) byKey.set(key, template)
  }
  return Array.from(byKey.values())
}

function ensureUniqueIds(templates) {
  const seen = new Map()
  return templates.map((template) => {
    const baseId = template.id || slugify(`${template.folder}-${template.title}`) || `template-${Date.now()}`
    const seenCount = seen.get(baseId) || 0
    seen.set(baseId, seenCount + 1)
    return { ...template, id: seenCount === 0 ? baseId : `${baseId}-${seenCount + 1}` }
  })
}

async function buildExpectedTemplates() {
  const templates = []
  let sourceMessages = 0
  let skippedByFolderMessages = 0
  let sequence = 0

  for (const filePath of await walkTemplateFiles(THUNDERBIRD_ROOT)) {
    const messages = splitMboxMessages(await fs.readFile(filePath, "utf8"))
    const folder = buildFolderLabel(filePath)
    sourceMessages += messages.length
    if (shouldSkipImportedFolder(folder)) {
      skippedByFolderMessages += messages.length
      continue
    }

    for (const message of messages) {
      const { headers, body } = extractBody(message)
      const subject = getHeaderValue(headers, "Subject")
      const title = subject || `${path.basename(filePath)} ${sequence + 1}`
      templates.push({
        id: slugify([folder || "root", path.basename(filePath), title, String(sequence + 1)].join("-")) || `template-${sequence + 1}`,
        title,
        subject,
        folder,
        from: getHeaderValue(headers, "From"),
        to: getHeaderValue(headers, "To"),
        cc: getHeaderValue(headers, "Cc"),
        bcc: getHeaderValue(headers, "Bcc") || getHeaderValue(headers, "BCC"),
        bodyHtml: body,
        bodyText: htmlToText(body),
      })
      sequence += 1
    }
  }

  const deduplicated = deduplicateTemplatesByContent(templates)
  deduplicated.sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title))
  return {
    templates: ensureUniqueIds(deduplicated),
    stats: {
      sourceMessages,
      skippedByFolderMessages,
      removedAsExactDuplicates: templates.length - deduplicated.length,
    },
  }
}

async function loadLiveTemplates() {
  const response = await fetch(TEMPLATE_API_URL, { cache: "no-store" })
  if (!response.ok) throw new Error(`Template API returned HTTP ${response.status}: ${await response.text()}`)
  const data = await response.json()
  return Array.isArray(data.templates) ? data.templates : []
}

function compareTemplates(expected, live) {
  const liveById = new Map(live.map((template) => [template.id, template]))
  const expectedById = new Map(expected.map((template) => [template.id, template]))
  const fields = ["title", "subject", "folder", "from", "to", "cc", "bcc", "bodyHtml", "bodyText"]
  const missing = []
  const extra = []
  const mismatches = []

  for (const expectedTemplate of expected) {
    const liveTemplate = liveById.get(expectedTemplate.id)
    if (!liveTemplate) {
      missing.push({ id: expectedTemplate.id, folder: expectedTemplate.folder, subject: expectedTemplate.subject })
      continue
    }
    const changedFields = fields.filter((field) => normaliseValue(expectedTemplate[field]) !== normaliseValue(liveTemplate[field]))
    if (changedFields.length) {
      mismatches.push({
        id: expectedTemplate.id,
        folder: expectedTemplate.folder,
        subject: expectedTemplate.subject,
        fields: changedFields,
        expected: { to: expectedTemplate.to, cc: expectedTemplate.cc, bcc: expectedTemplate.bcc },
        live: { to: liveTemplate.to, cc: liveTemplate.cc, bcc: liveTemplate.bcc },
      })
    }
  }

  for (const liveTemplate of live) {
    if (!expectedById.has(liveTemplate.id)) extra.push({ id: liveTemplate.id, folder: liveTemplate.folder, subject: liveTemplate.subject })
  }

  return { missing, extra, mismatches }
}

const { templates: expectedTemplates, stats } = await buildExpectedTemplates()
const liveTemplates = await loadLiveTemplates()
const comparison = compareTemplates(expectedTemplates, liveTemplates)
const focus = liveTemplates
  .filter((template) => /Bunkering Notice From Fratelli Cosulich|Market Report|Price Change Notice/i.test(`${template.folder} ${template.subject}`))
  .map((template) => ({ id: template.id, folder: template.folder, subject: template.subject, to: template.to, cc: template.cc, bcc: template.bcc }))

console.log(JSON.stringify({
  counts: {
    expectedImportedTemplates: expectedTemplates.length,
    liveTemplates: liveTemplates.length,
    sourceMessages: stats.sourceMessages,
    skippedByFolderMessages: stats.skippedByFolderMessages,
    removedAsExactDuplicates: stats.removedAsExactDuplicates,
  },
  discrepancies: {
    missing: comparison.missing.length,
    extra: comparison.extra.length,
    mismatches: comparison.mismatches.length,
  },
  firstProblems: {
    missing: comparison.missing.slice(0, 10),
    extra: comparison.extra.slice(0, 10),
    mismatches: comparison.mismatches.slice(0, 10),
  },
  focus,
}, null, 2))

if (comparison.missing.length || comparison.extra.length || comparison.mismatches.length) process.exitCode = 1
