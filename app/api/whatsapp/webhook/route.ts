import { NextResponse } from "next/server"
import { acknowledgeSpcMobileDelivery, recordSpcMobileMessageStatus, verifyMetaWebhookSignature } from "@/lib/spcMobileEnquiries"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  if (params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(params.get("hub.challenge") || "", { status: 200 })
  }
  return new Response("Forbidden", { status: 403 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (!verifyMetaWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid signature", { status: 401 })
  }
  const payload = JSON.parse(rawBody) as { entry?: Array<{ changes?: Array<{ value?: { messages?: unknown[]; statuses?: unknown[] } }> }> }
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const item of change.value?.statuses || []) {
        if (!item || typeof item !== "object") continue
        await recordSpcMobileMessageStatus(String((item as { id?: unknown }).id || ""), String((item as { status?: unknown }).status || ""))
      }
      for (const item of change.value?.messages || []) {
        if (!item || typeof item !== "object") continue
        const message = item as { from?: unknown; text?: { body?: unknown }; button?: { payload?: unknown }; interactive?: { button_reply?: { id?: unknown } } }
        const from = String(message.from || "").replace(/\D/g, "")
        const payloadValue = String(message.button?.payload || message.interactive?.button_reply?.id || "")
        const token = payloadValue.startsWith("RECEIVE_") ? payloadValue.slice(8) : undefined
        const plainOk = /^ok$/i.test(String(message.text?.body || "").trim())
        if (from && (token || plainOk)) await acknowledgeSpcMobileDelivery(from, token)
      }
    }
  }
  return NextResponse.json({ received: true })
}
