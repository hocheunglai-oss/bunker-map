import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

async function graph(path: string, init?: RequestInit, token = requireEnv("WHATSAPP_ACCESS_TOKEN")) {
  const response = await fetch(`https://graph.facebook.com/${requireEnv("WHATSAPP_GRAPH_API_VERSION")}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`Meta setup request failed (${response.status}).`)
  return payload as Record<string, unknown>
}

async function setup() {
  let stage = "authorization"
  try {
    await requireSpcPagePermission("spc-user-management", "edit")
    stage = "resolve-phone"
    const phoneId = requireEnv("SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID")
    const phone = await graph(`${phoneId}?fields=whatsapp_business_account`)
    const account = phone.whatsapp_business_account as { id?: unknown } | undefined
    const wabaId = String(account?.id || "")
    if (!/^\d{5,30}$/.test(wabaId)) throw new Error("WhatsApp Business account could not be resolved.")

    stage = "check-template"
    const existing = await graph(`${wabaId}/message_templates?name=spc_mobile_enquiry_ready&fields=id,name,status`)
    const templates = Array.isArray(existing.data) ? existing.data : []
    let template = templates[0] as Record<string, unknown> | undefined
    if (!template) {
      stage = "create-template"
      template = await graph(`${wabaId}/message_templates`, {
        method: "POST",
        body: JSON.stringify({
          name: "spc_mobile_enquiry_ready",
          language: "en_US",
          category: "UTILITY",
          allow_category_change: true,
          components: [
            { type: "BODY", text: "New SPC enquiry {{1}} is ready. Tap RECEIVE to view it.", example: { body_text: [["SPC-20260813-0001"]] } },
            { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "RECEIVE" }] },
          ],
        }),
      })
    }

    stage = "subscribe-business-account"
    await graph(`${wabaId}/subscribed_apps`, { method: "POST", body: JSON.stringify({}) })
    const token = requireEnv("WHATSAPP_ACCESS_TOKEN")
    stage = "resolve-application"
    const debug = await graph(`debug_token?input_token=${encodeURIComponent(token)}`)
    const appId = String((debug.data as { app_id?: unknown } | undefined)?.app_id || "")
    if (!/^\d{5,30}$/.test(appId)) throw new Error("Meta application could not be resolved.")
    const appToken = `${appId}|${requireEnv("WHATSAPP_APP_SECRET")}`
    stage = "register-callback"
    await graph(`${appId}/subscriptions`, {
      method: "POST",
      body: JSON.stringify({
        object: "whatsapp_business_account",
        callback_url: "https://spc.fcuno.com/api/whatsapp/webhook",
        verify_token: requireEnv("WHATSAPP_VERIFY_TOKEN"),
        fields: "messages",
        include_values: true,
      }),
    }, appToken)

    return NextResponse.json({ success: true, templateStatus: String(template.status || "PENDING") })
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp mobile setup failed."
    return NextResponse.json({ message: `${stage}: ${message}` }, { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 })
  }
}

export const GET = setup
export const POST = setup
