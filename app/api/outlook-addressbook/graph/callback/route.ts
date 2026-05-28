import { NextResponse } from "next/server"
import { getGraphConfig, saveGraphStore } from "../_shared"

function html(title: string, body: string) {
  return new NextResponse(
    `<!doctype html><html><head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family:Arial,sans-serif;background:#071a2c;color:#edf7ff;padding:32px"><h1>${title}</h1><p>${body}</p><p>You may close this tab and return to FC Uno.</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  )
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const config = getGraphConfig(request)
  const state = url.searchParams.get("state") || ""
  const adminConsent = url.searchParams.get("admin_consent") === "True"
  const tenantId = url.searchParams.get("tenant") || ""
  const error = url.searchParams.get("error_description") || url.searchParams.get("error")

  if (error) return html("Microsoft Graph Consent Failed", error)
  if (state !== config.state) return html("Microsoft Graph Consent Failed", "The consent state did not match.")
  if (!adminConsent || !tenantId) return html("Microsoft Graph Consent Failed", "Admin consent was not completed.")

  await saveGraphStore({
    tenantId,
    adminConsent: true,
    consentedAt: new Date().toISOString(),
  })

  return html("Microsoft Graph Consent Saved", "Admin consent has been recorded for this tenant.")
}
