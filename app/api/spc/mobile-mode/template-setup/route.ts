import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"

function env(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} unavailable`); return value }
async function meta(path: string, init?: RequestInit) {
  const response = await fetch(`https://graph.facebook.com/${env("WHATSAPP_GRAPH_API_VERSION")}/${path}`, {
    ...init, headers: { Authorization: `Bearer ${env("WHATSAPP_ACCESS_TOKEN")}`, "Content-Type": "application/json" }, cache: "no-store",
  })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new Error(`Meta rejected setup (${response.status})`)
  return payload || {}
}
export async function POST() {
  try {
    await requireSpcPagePermission("spc-user-management", "edit")
    const token = env("WHATSAPP_ACCESS_TOKEN")
    const debug = await meta(`debug_token?input_token=${encodeURIComponent(token)}`)
    const data = debug.data as { granular_scopes?: Array<{ scope?: unknown; target_ids?: unknown[] }> } | undefined
    const wabaId = data?.granular_scopes?.find((scope) => String(scope.scope || "").includes("whatsapp_business"))?.target_ids?.map(String).find((id) => /^\d{5,30}$/.test(id)) || ""
    if (!wabaId) throw new Error("WhatsApp Business account unavailable")
    const existing = await meta(`${wabaId}/message_templates?name=spc_mobile_mode_on&fields=id,name,status`)
    const templates = Array.isArray(existing.data) ? existing.data as Array<Record<string, unknown>> : []
    const template = templates[0] || await meta(`${wabaId}/message_templates`, {
      method: "POST",
      body: JSON.stringify({ name: "spc_mobile_mode_on", language: "en_US", category: "UTILITY", allow_category_change: true,
        components: [
          { type: "BODY", text: "Mobile Mode is now on. Tap RECEIVE to activate direct SPC enquiry delivery for the next 24 hours." },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "RECEIVE" }] },
        ],
      }),
    })
    return NextResponse.json({ success: true, status: String(template.status || "PENDING") })
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "Setup failed" }, { status: 500 })
  }
}
