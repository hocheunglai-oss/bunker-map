import { NextResponse } from "next/server"

const HTML_TEXT_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeHtmlText(value: string) {
  return value.replace(/[&<>"']/g, (character) => HTML_TEXT_ESCAPE[character])
}

export function graphCallbackHtmlResponse(title: string, body: string) {
  const safeTitle = escapeHtmlText(title)
  const safeBody = escapeHtmlText(body)

  return new NextResponse(
    `<!doctype html><html><head><title>${safeTitle}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family:Arial,sans-serif;background:#071a2c;color:#edf7ff;padding:32px"><h1>${safeTitle}</h1><p>${safeBody}</p><p>You may close this tab and return to FC Uno.</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  )
}
