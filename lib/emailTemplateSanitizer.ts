export type SanitizableEmailTemplate = {
  subject?: string
  to?: string
  cc?: string
  bcc?: string
  bodyHtml?: string
  bodyText?: string
}

const MIME_HEADER_RE =
  /^(content-type|content-transfer-encoding|content-disposition|mime-version|x-[a-z0-9-]+|charset|boundary)\b/i

function decodeQuotedPrintable(value: string) {
  if (!/(=\r?\n|=[0-9a-fA-F]{2})/.test(value)) return value

  const withoutSoftBreaks = value.replace(/=\r?\n/g, "")
  const decoder = new TextDecoder("utf-8", { fatal: false })
  const bytes: number[] = []
  let output = ""

  function flushBytes() {
    if (!bytes.length) return
    output += decoder.decode(new Uint8Array(bytes))
    bytes.length = 0
  }

  for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
    const char = withoutSoftBreaks[index]
    const hex = withoutSoftBreaks.slice(index + 1, index + 3)
    if (char === "=" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      index += 2
      continue
    }
    flushBytes()
    output += char
  }

  flushBytes()
  return output
}

function decodeBase64Text(value: string) {
  const compact = value.replace(/[^a-zA-Z0-9+/=]/g, "")
  if (compact.length < 16 || compact.length % 4 === 1) return value
  try {
    return Buffer.from(compact, "base64").toString("utf8")
  } catch {
    return value
  }
}

function decodeRfc2047(value: string) {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bq])\?([\s\S]*?)\?=/gi, (_match, charset, encoding, content) => {
      const normalizedCharset = String(charset || "").toLowerCase()
      if (normalizedCharset && !/utf-?8|us-ascii|iso-8859-1/.test(normalizedCharset)) return content
      if (String(encoding).toLowerCase() === "b") return decodeBase64Text(content)
      return decodeQuotedPrintable(String(content).replace(/_/g, " "))
    })
    .replace(/\s{2,}/g, " ")
    .trim()
}

function extractEncodedMimePart(value: string) {
  if (!/Content-Transfer-Encoding:\s*(base64|quoted-printable)/i.test(value)) return ""

  const parts = value.split(/\n--[^\n]+/g)
  const decodedParts: Array<{ type: string; content: string }> = []

  for (const part of parts) {
    const typeMatch = part.match(/Content-Type:\s*text\/(html|plain)\b/i)
    const encodingMatch = part.match(/Content-Transfer-Encoding:\s*(base64|quoted-printable)\b/i)
    if (!typeMatch || !encodingMatch) continue

    const bodyStart = part.search(/\n\s*\n/)
    if (bodyStart < 0) continue

    const rawBody = part.slice(bodyStart).trim()
    const encoding = encodingMatch[1].toLowerCase()
    const content = encoding === "base64" ? decodeBase64Text(rawBody) : decodeQuotedPrintable(rawBody)
    if (content.trim()) decodedParts.push({ type: typeMatch[1].toLowerCase(), content })
  }

  return decodedParts.find((part) => part.type === "html")?.content || decodedParts[0]?.content || ""
}

function cleanEncodedEntities(value: string) {
  return value
    .replace(/&nbs\s*=\s*p;/gi, " ")
    .replace(/&nbsp\s*=\s*p;/gi, " ")
    .replace(/&nb\s+sp;/gi, " ")
    .replace(/&amp;nbsp;/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/�/g, "")
}

function decodeBasicHtmlEntities(value: string) {
  return cleanEncodedEntities(value)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const number = Number(code)
      return Number.isFinite(number) ? String.fromCodePoint(number) : ""
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const number = parseInt(code, 16)
      return Number.isFinite(number) ? String.fromCodePoint(number) : ""
    })
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function stripTagsToText(value: string) {
  return decodeBasicHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
}

function stripMimeNoise(value: string) {
  let text = value
    .replace(/^This is a multi-part message in MIME format\.?\s*/i, "")
    .replace(/^--[^\r\n-]+--?\s*$/gm, "")

  const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) return bodyMatch[1]

  const firstHtml = text.search(/<(?:table|p|div|span|br|font|html|body)\b/i)
  if (firstHtml > 0) text = text.slice(firstHtml)

  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^--/.test(trimmed)) return false
      if (MIME_HEADER_RE.test(trimmed)) return false
      if (/^(name|filename)\*?=/i.test(trimmed)) return false
      return true
    })
    .join("\n")
}

function normaliseLineBreaks(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function prepareRawContent(value: string) {
  const normalized = normaliseLineBreaks(value || "")
  const encodedMimePart = extractEncodedMimePart(normalized)
  const decoded = decodeQuotedPrintable(encodedMimePart || normalized)
  return stripMimeNoise(cleanEncodedEntities(decoded))
    .replace(/(^|[^=])=\r?\n/g, "$1")
    .replace(/^\s*=\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
}

function extractCells(rowHtml: string) {
  return Array.from(rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi))
    .map((match) => stripTagsToText(match[1] || "").replace(/[ \t]+/g, " ").trim())
}

function tableHtmlToText(tableHtml: string) {
  const rows = Array.from(tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi))
    .map((match) => extractCells(match[1] || ""))
    .map((cells) => cells.filter((cell, index) => cell || index < 3))
    .filter((cells) => cells.some(Boolean))

  if (!rows.length) {
    return stripTagsToText(tableHtml).replace(/[ \t]+/g, " ").trim()
  }

  const labelRows = rows.map((cells) => {
    const colonIndex = cells.findIndex((cell) => cell.trim() === ":")
    if (colonIndex >= 0) {
      return {
        label: cells.slice(0, colonIndex).join(" ").trim(),
        value: cells.slice(colonIndex + 1).join(" ").trim(),
      }
    }
    if (cells.length >= 2 && cells[0] && cells.length <= 3) {
      return {
        label: cells[0].trim(),
        value: cells.slice(1).join(" ").trim(),
      }
    }
    return null
  })

  const canAlign = labelRows.some(Boolean) && labelRows.filter(Boolean).length >= Math.ceil(rows.length / 2)
  if (canAlign) {
    const labels = labelRows.map((row) => row?.label || "")
    const width = Math.min(Math.max(...labels.map((label) => label.length), 0), 24)
    return labelRows
      .map((row, index) => {
        if (!row) return rows[index].join("  ").trim()
        if (!row.label && !row.value) return ""
        return `${row.label.padEnd(width, " ")} : ${row.value}`.trimEnd()
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  const columnWidths = rows.reduce<number[]>((widths, cells) => {
    cells.forEach((cell, index) => {
      widths[index] = Math.min(Math.max(widths[index] || 0, cell.length), 32)
    })
    return widths
  }, [])

  return rows
    .map((cells) =>
      cells
        .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(columnWidths[index] || 0, " ")))
        .join("  ")
        .trimEnd()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function replaceTablesWithPre(value: string) {
  return value.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const text = tableHtmlToText(table)
    if (!text) return ""
    return `<pre style="font-family: Arial, Helvetica, sans-serif; white-space: pre-wrap; margin: 0;">${escapeHtml(text)}</pre>`
  })
}

export function htmlToPlainText(html: string) {
  return stripTagsToText(
    replaceTablesWithPre(prepareRawContent(html))
      .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, content) => `\n${decodeBasicHtmlEntities(content)}\n`)
      .replace(/<\/(p|div|pre)>/gi, "\n")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function sanitizeTemplateBodyHtml(value: string) {
  const prepared = prepareRawContent(value)
  const withoutWrappers = prepared
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?(html|head|body)[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<title\b[\s\S]*?<\/title>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")

  let converted = replaceTablesWithPre(withoutWrappers)
    .replace(/(^|[^=])=\r?\n/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (/<(?:table|tbody|tr|td|th)\b/i.test(converted)) {
    const text = sanitizeTemplateText(converted)
    converted = text
      ? `<pre style="font-family: Arial, Helvetica, sans-serif; white-space: pre-wrap; margin: 0;">${escapeHtml(text)}</pre>`
      : ""
  }

  if (!converted) return "<p></p>"
  if (/<[a-z][\s\S]*>/i.test(converted)) return converted
  return escapeHtml(converted).replace(/\n/g, "<br>")
}

export function sanitizeTemplateText(value: string) {
  return decodeBasicHtmlEntities(prepareRawContent(value))
    .replace(/<table\b[\s\S]*?<\/table>/gi, (table) => `\n${tableHtmlToText(table)}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|pre|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/(^|[^=])=\r?\n/g, "$1")
    .replace(/^\s*=\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function sanitizeTemplateField(value: string) {
  return decodeRfc2047(decodeBasicHtmlEntities(prepareRawContent(value))).replace(/[ \t]+/g, " ").trim()
}

export function sanitizeEmailTemplate<T extends SanitizableEmailTemplate>(template: T): T {
  const bodyHtml = sanitizeTemplateBodyHtml(template.bodyHtml || "")
  const sourceText = sanitizeTemplateText(template.bodyText || "")
  const htmlText = htmlToPlainText(bodyHtml)
  const bodyText = bodyHtml && bodyHtml !== "<p></p>"
    ? htmlText || sourceText
    : sourceText || htmlText

  return {
    ...template,
    subject: sanitizeTemplateField(template.subject || ""),
    to: sanitizeTemplateField(template.to || ""),
    cc: sanitizeTemplateField(template.cc || ""),
    bcc: sanitizeTemplateField(template.bcc || ""),
    bodyHtml,
    bodyText,
  }
}

export function findTemplateFormattingIssues(template: SanitizableEmailTemplate) {
  const fields = [template.subject, template.to, template.cc, template.bcc, template.bodyHtml, template.bodyText]
    .map((value) => value || "")
    .join("\n")
  const issues: string[] = []

  if (/&nbs\s*=\s*p;|&nbsp\s*=\s*p;|&nb\s+sp;|&amp;nbsp;|&nbsp;/i.test(fields)) issues.push("encoded-space")
  if (/(^|[^=])=\r?\n|=[0-9a-fA-F]{2}/.test(fields)) issues.push("quoted-printable")
  if (/Content-Transfer-Encoding|This is a multi-part message|^--[_=][^\r\n]+/im.test(fields)) issues.push("mime-wrapper")
  if (/<table\b|<tbody\b|<tr\b|<td\b/i.test(fields)) issues.push("html-table")
  if (/[�]/.test(fields)) issues.push("replacement-character")

  return Array.from(new Set(issues))
}
