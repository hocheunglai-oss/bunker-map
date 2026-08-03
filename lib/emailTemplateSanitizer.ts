import sanitizeHtml from "sanitize-html"

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

const SAFE_HTML_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "caption",
  "center",
  "code",
  "col",
  "colgroup",
  "div",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]

const NON_TEXT_HTML_TAGS = [
  "audio",
  "button",
  "canvas",
  "embed",
  "form",
  "head",
  "iframe",
  "math",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "option",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "video",
  "xmp",
]

const CSS_DANGEROUS_VALUE_RE =
  /(?:url\s*\(|expression\s*\(|@import|javascript\s*:|vbscript\s*:|data\s*:|behavior\s*:|-moz-binding|[<>])/i
const CSS_SAFE_TOKEN_SOURCE = String.raw`[a-z0-9#(),.%'"\s_-]{1,256}`
const CSS_LENGTH_SOURCE =
  String.raw`(?:0|auto|-?(?:\d{1,4}(?:\.\d{1,3})?|\.\d{1,3})(?:px|pt|pc|em|rem|ex|ch|%|in|cm|mm)?)`
const CSS_LENGTH_LIST_SOURCE = String.raw`${CSS_LENGTH_SOURCE}(?:\s+${CSS_LENGTH_SOURCE}){0,3}`
const CSS_COLOR_SOURCE =
  String.raw`(?:transparent|currentcolor|#[0-9a-f]{3,8}|[a-z]{1,24}|rgba?\(\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?\s*,\s*\d{1,3}(?:\.\d+)?%?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))`

function safeCssPattern(source: string) {
  return new RegExp(
    String.raw`^(?![\s\S]*${CSS_DANGEROUS_VALUE_RE.source})${source}$`,
    "i"
  )
}

const CSS_LENGTH_RE = safeCssPattern(CSS_LENGTH_SOURCE)
const CSS_LENGTH_LIST_RE = safeCssPattern(CSS_LENGTH_LIST_SOURCE)
const CSS_COLOR_RE = safeCssPattern(CSS_COLOR_SOURCE)
const CSS_BORDER_RE = safeCssPattern(CSS_SAFE_TOKEN_SOURCE)
const CSS_FONT_FAMILY_RE = safeCssPattern(String.raw`[a-z0-9'"\s,_-]{1,160}`)
const CSS_FONT_SIZE_RE = safeCssPattern(
  String.raw`(?:${CSS_LENGTH_SOURCE}|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)`
)
const CSS_LINE_HEIGHT_RE = safeCssPattern(
  String.raw`(?:normal|${CSS_LENGTH_SOURCE}|(?:\d{1,3}(?:\.\d{1,3})?|\.\d{1,3}))`
)

function cleanUri(value: string) {
  return decodeBasicHtmlEntities(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim()
}

function uriScheme(value: string) {
  const compact = value.replace(/\s+/g, "")
  return compact.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() || ""
}

function isSafeFcunoHDriveHref(value: string) {
  if (!/^file:\/\/\/h:\//i.test(value) || /[\\?#]/.test(value)) return false

  let decoded = ""
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return false
  }

  if (!/^file:\/\/\/h:\//i.test(decoded) || /[\\?#]/.test(decoded)) return false
  const path = decoded.slice("file:///H:/".length)
  if (!path) return false

  return path
    .split("/")
    .every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
}

function isSafeLinkHref(value: string) {
  const href = cleanUri(value)
  if (!href || href.startsWith("//")) return false

  const scheme = uriScheme(href)
  if (scheme === "file") return isSafeFcunoHDriveHref(href)
  return !scheme || ["http", "https", "mailto", "tel"].includes(scheme)
}

function isSafeImageSource(value: string) {
  const src = cleanUri(value)
  if (!src || src.startsWith("//")) return false

  const scheme = uriScheme(src)
  if (!scheme) return true
  if (scheme === "http" || scheme === "https") return true
  if (scheme === "cid") return /^cid:[^<>'"\s]+$/i.test(src)
  if (scheme === "data") {
    return /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(src)
  }
  return false
}

function sanitizeHtmlAllowlist(value: string) {
  return sanitizeHtml(value, {
    allowedTags: SAFE_HTML_TAGS,
    allowedAttributes: {
      "*": ["style", "title", "dir", "lang"],
      a: ["href", "rel", "target", "title"],
      blockquote: ["cite", "style"],
      col: ["align", "span", "style", "width"],
      font: ["color", "face", "size", "style"],
      img: ["alt", "height", "src", "style", "title", "width"],
      li: ["style", "type", "value"],
      ol: ["start", "style", "type"],
      table: [
        "align",
        "bgcolor",
        "border",
        "cellpadding",
        "cellspacing",
        "data-fc-safe-template-table",
        "height",
        "role",
        "style",
        "width",
      ],
      td: [
        "align",
        "bgcolor",
        "colspan",
        "headers",
        "height",
        "rowspan",
        "style",
        "valign",
        "width",
      ],
      th: [
        "align",
        "bgcolor",
        "colspan",
        "headers",
        "height",
        "rowspan",
        "scope",
        "style",
        "valign",
        "width",
      ],
      tr: ["align", "bgcolor", "height", "style", "valign"],
      ul: ["style", "type"],
    },
    allowedStyles: {
      "*": {
        "background": [CSS_COLOR_RE],
        "background-color": [CSS_COLOR_RE],
        "border": [CSS_BORDER_RE],
        "border-bottom": [CSS_BORDER_RE],
        "border-color": [CSS_COLOR_RE],
        "border-left": [CSS_BORDER_RE],
        "border-right": [CSS_BORDER_RE],
        "border-style": [safeCssPattern(String.raw`(?:none|hidden|dotted|dashed|solid|double)(?:\s+(?:none|hidden|dotted|dashed|solid|double)){0,3}`)],
        "border-top": [CSS_BORDER_RE],
        "border-width": [CSS_LENGTH_LIST_RE],
        "color": [CSS_COLOR_RE],
        "direction": [safeCssPattern(String.raw`(?:ltr|rtl)`)],
        "font-family": [CSS_FONT_FAMILY_RE],
        "font-size": [CSS_FONT_SIZE_RE],
        "font-style": [safeCssPattern(String.raw`(?:normal|italic|oblique)`)],
        "font-weight": [safeCssPattern(String.raw`(?:normal|bold|bolder|lighter|[1-9]00)`)],
        "height": [CSS_LENGTH_RE],
        "letter-spacing": [CSS_LENGTH_RE],
        "line-height": [CSS_LINE_HEIGHT_RE],
        "list-style-position": [safeCssPattern(String.raw`(?:inside|outside)`)],
        "list-style-type": [safeCssPattern(String.raw`[a-z-]{1,32}`)],
        "margin": [CSS_LENGTH_LIST_RE],
        "margin-bottom": [CSS_LENGTH_RE],
        "margin-left": [CSS_LENGTH_RE],
        "margin-right": [CSS_LENGTH_RE],
        "margin-top": [CSS_LENGTH_RE],
        "max-height": [CSS_LENGTH_RE],
        "max-width": [CSS_LENGTH_RE],
        "min-height": [CSS_LENGTH_RE],
        "min-width": [CSS_LENGTH_RE],
        "mso-bidi-font-family": [CSS_FONT_FAMILY_RE],
        "mso-fareast-font-family": [CSS_FONT_FAMILY_RE],
        "mso-fareast-language": [safeCssPattern(String.raw`[a-z0-9-]{1,24}`)],
        "mso-line-height-rule": [safeCssPattern(String.raw`(?:exactly|at-least)`)],
        "mso-padding-alt": [CSS_LENGTH_LIST_RE],
        "mso-para-margin": [CSS_LENGTH_LIST_RE],
        "mso-para-margin-bottom": [CSS_LENGTH_RE],
        "mso-para-margin-left": [CSS_LENGTH_RE],
        "mso-para-margin-right": [CSS_LENGTH_RE],
        "mso-para-margin-top": [CSS_LENGTH_RE],
        "mso-table-lspace": [CSS_LENGTH_RE],
        "mso-table-rspace": [CSS_LENGTH_RE],
        "mso-text-raise": [CSS_LENGTH_RE],
        "padding": [CSS_LENGTH_LIST_RE],
        "padding-bottom": [CSS_LENGTH_RE],
        "padding-left": [CSS_LENGTH_RE],
        "padding-right": [CSS_LENGTH_RE],
        "padding-top": [CSS_LENGTH_RE],
        "table-layout": [safeCssPattern(String.raw`(?:auto|fixed)`)],
        "text-align": [safeCssPattern(String.raw`(?:left|right|center|justify|start|end)`)],
        "text-decoration": [safeCssPattern(String.raw`(?:none|underline|overline|line-through)(?:\s+(?:underline|overline|line-through)){0,2}`)],
        "text-indent": [CSS_LENGTH_RE],
        "text-transform": [safeCssPattern(String.raw`(?:none|capitalize|uppercase|lowercase)`)],
        "vertical-align": [
          safeCssPattern(
            String.raw`(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom|${CSS_LENGTH_SOURCE})`
          ),
        ],
        "white-space": [safeCssPattern(String.raw`(?:normal|nowrap|pre|pre-wrap|pre-line|break-spaces)`)],
        "width": [CSS_LENGTH_RE],
        "word-break": [safeCssPattern(String.raw`(?:normal|break-all|keep-all|break-word)`)],
        "word-spacing": [CSS_LENGTH_RE],
        "overflow-wrap": [safeCssPattern(String.raw`(?:normal|break-word|anywhere)`)],
        "border-collapse": [safeCssPattern(String.raw`(?:collapse|separate)`)],
        "border-spacing": [safeCssPattern(String.raw`${CSS_LENGTH_SOURCE}(?:\s+${CSS_LENGTH_SOURCE})?`)],
        "empty-cells": [safeCssPattern(String.raw`(?:show|hide)`)],
      },
    },
    allowedSchemes: ["http", "https", "mailto", "tel", "file"],
    allowedSchemesByTag: {
      img: ["http", "https", "cid", "data"],
    },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: false,
    nestingLimit: 50,
    nonTextTags: NON_TEXT_HTML_TAGS,
    transformTags: {
      a: (tagName, attribs) => {
        const href = isSafeLinkHref(attribs.href || "") ? cleanUri(attribs.href) : ""
        const target = attribs.target === "_blank" || attribs.target === "_self"
          ? attribs.target
          : ""
        const rel = target === "_blank" ? "noopener noreferrer" : ""
        const nextAttribs = { ...attribs }
        delete nextAttribs.href
        delete nextAttribs.rel
        delete nextAttribs.target

        return {
          tagName,
          attribs: {
            ...nextAttribs,
            ...(href ? { href } : {}),
            ...(target ? { target } : {}),
            ...(rel ? { rel } : {}),
          },
        }
      },
      img: (tagName, attribs) => {
        const src = isSafeImageSource(attribs.src || "") ? cleanUri(attribs.src) : ""
        const nextAttribs = { ...attribs }
        delete nextAttribs.src
        return {
          tagName,
          attribs: {
            ...nextAttribs,
            ...(src ? { src } : {}),
          },
        }
      },
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "a" && !frame.attribs.href) return "excludeTag"
      if (frame.tag === "img" && !frame.attribs.src) return true
      return false
    },
  })
}

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
    .map((match) => stripTagsToText(match[1] || "").replace(/\s+/g, " ").trim())
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

function buildSafeTable(rows: string[][], labelStyle = false) {
  const tableStyle = [
    "border-collapse:collapse",
    "mso-table-lspace:0pt",
    "mso-table-rspace:0pt",
    "font-family:Arial, Helvetica, sans-serif",
    "font-size:14px",
    "line-height:1.35",
  ].join(";")
  const baseCellStyle = "border:1px solid #b8c0c8;padding:4px 7px;vertical-align:top"
  const labelCellStyle = `${baseCellStyle};font-weight:normal;white-space:nowrap;background:#f7f9fb`
  const colonCellStyle = `${baseCellStyle};text-align:center;width:16px`
  const valueCellStyle = `${baseCellStyle};min-width:150px`

  const body = rows
    .map((cells) => {
      if (labelStyle) {
        const label = cells[0] || ""
        const value = cells[1] || ""
        return `<tr><td style="${labelCellStyle}">${escapeHtml(label)}</td><td style="${colonCellStyle}">:</td><td style="${valueCellStyle}">${escapeHtml(value)}</td></tr>`
      }

      return `<tr>${cells
        .map((cell) => `<td style="${baseCellStyle}">${escapeHtml(cell)}</td>`)
        .join("")}</tr>`
    })
    .join("")

  return `<table data-fc-safe-template-table="1" role="presentation" cellspacing="0" cellpadding="0" border="0" style="${tableStyle}"><tbody>${body}</tbody></table>`
}

function tableHtmlToSafeTable(tableHtml: string) {
  const rows = Array.from(tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi))
    .map((match) => extractCells(match[1] || ""))
    .map((cells) => cells.filter((cell, index) => cell || index < 3))
    .filter((cells) => cells.some(Boolean))

  if (!rows.length) {
    const text = stripTagsToText(tableHtml).replace(/\s+/g, " ").trim()
    return text ? buildSafeTable([[text]], false) : ""
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

  const canUseLabelTable =
    labelRows.some(Boolean) && labelRows.filter(Boolean).length >= Math.ceil(rows.length / 2)

  if (canUseLabelTable) {
    return buildSafeTable(
      labelRows.map((row, index) => (row ? [row.label, row.value] : [rows[index].join("  ").trim(), ""])),
      true
    )
  }

  return buildSafeTable(rows, false)
}

function replaceTablesWithSafeTables(value: string) {
  return value.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    return tableHtmlToSafeTable(table)
  })
}

export function htmlToPlainText(html: string) {
  return stripTagsToText(
    prepareRawContent(html)
      .replace(/<table\b[\s\S]*?<\/table>/gi, (table) => `\n${tableHtmlToText(table)}\n`)
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

  let converted = replaceTablesWithSafeTables(withoutWrappers)
    .replace(/(^|[^=])=\r?\n/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (/<(?:tbody|tr|td|th)\b/i.test(converted) && !/<table\b[^>]*data-fc-safe-template-table="1"/i.test(converted)) {
    const text = sanitizeTemplateText(converted)
    converted = text
      ? buildSafeTable(
          text.split(/\n+/).map((line) => [line.trim()]).filter((row) => row[0]),
          false
        )
      : ""
  }

  const sanitized = sanitizeHtmlAllowlist(converted)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (!sanitized) return "<p></p>"
  if (/<[a-z][\s\S]*>/i.test(sanitized)) return sanitized
  return sanitized.replace(/\n/g, "<br>")
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
  if (/<table\b(?![^>]*data-fc-safe-template-table="1")|<colgroup\b/i.test(fields)) {
    issues.push("html-table")
  }
  if (/[�]/.test(fields)) issues.push("replacement-character")

  return Array.from(new Set(issues))
}
