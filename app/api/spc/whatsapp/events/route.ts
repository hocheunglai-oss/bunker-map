import { randomUUID } from "crypto"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { getServiceSupabaseClient } from "@/lib/whatsapp"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

type RealtimePayload = {
  eventType?: string
  new?: Record<string, unknown>
  old?: Record<string, unknown>
}

function conversationId(payload: RealtimePayload) {
  const nextId = payload.new?.conversation_id || payload.new?.id
  const oldId = payload.old?.conversation_id || payload.old?.id
  return typeof nextId === "string" ? nextId : typeof oldId === "string" ? oldId : null
}

export async function GET(request: Request) {
  try {
    await requireSpcPagePermission("spc-whatsapp", "view")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized"
    return Response.json(
      { message },
      { status: message === "Unauthorized" ? 401 : 403 },
    )
  }

  const encoder = new TextEncoder()
  const supabase = getServiceSupabaseClient()
  let cleanupStream: (() => void) | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let channel: ReturnType<typeof supabase.channel> | null = null

      const send = (event: string, data: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          )
        } catch {
          closed = true
        }
      }

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (channel) void supabase.removeChannel(channel)
        try {
          controller.close()
        } catch {}
      }
      cleanupStream = cleanup

      channel = supabase
        .channel(`whatsapp-spc-events-${randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "whatsapp_conversations" },
          (payload: RealtimePayload) => {
            send("whatsapp-change", {
              table: "whatsapp_conversations",
              eventType: payload.eventType || "change",
              conversationId: conversationId(payload),
            })
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "whatsapp_messages" },
          (payload: RealtimePayload) => {
            send("whatsapp-change", {
              table: "whatsapp_messages",
              eventType: payload.eventType || "change",
              conversationId: conversationId(payload),
            })
          },
        )
        .subscribe((status) => {
          send("whatsapp-status", { status })
        })

      heartbeat = setInterval(() => {
        send("whatsapp-ping", { at: new Date().toISOString() })
      }, 25000)

      send("whatsapp-ready", { ready: true })
      request.signal.addEventListener("abort", cleanup)
    },
    cancel() {
      cleanupStream?.()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
