import { NextResponse } from "next/server"
import {
  getWhatsAppWebhookVerifyToken,
  storeInboundWebhook,
  verifyWhatsAppSignature,
} from "@/lib/whatsapp"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")
  const verifyToken = getWhatsAppWebhookVerifyToken()

  if (mode === "subscribe" && token && challenge && verifyToken && token === verifyToken) {
    return new NextResponse(challenge, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
      },
    })
  }

  return NextResponse.json({ message: "Webhook verification failed." }, { status: 403 })
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()
    const signature = request.headers.get("x-hub-signature-256")
    if (!verifyWhatsAppSignature(rawBody, signature)) {
      return NextResponse.json({ message: "Invalid WhatsApp signature." }, { status: 401 })
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>
    await storeInboundWebhook(payload)

    return NextResponse.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process WhatsApp webhook."
    console.error("whatsapp webhook failed", error)
    return NextResponse.json({ success: false, message }, { status: 200 })
  }
}
