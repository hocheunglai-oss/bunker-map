import { NextResponse } from "next/server"

import { requireSpcPagePermission } from "@/lib/spcAuth"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type GeneratePayload = {
  action?: "response" | "speech"
  input?: string
}

function cleanInput(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function extractOutputText(payload: unknown) {
  if (!payload || typeof payload !== "object") return ""
  const source = payload as Record<string, unknown>
  if (typeof source.output_text === "string") return source.output_text.trim()

  const output = Array.isArray(source.output) ? source.output : []
  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const content = (item as Record<string, unknown>).content
      if (!Array.isArray(content)) return []
      return content.flatMap((part) => {
        if (!part || typeof part !== "object") return []
        const text = (part as Record<string, unknown>).text
        return typeof text === "string" ? [text] : []
      })
    })
    .join("\n")
    .trim()
}

function providerMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback
  const error = (payload as Record<string, unknown>).error
  if (!error || typeof error !== "object") return fallback
  const message = (error as Record<string, unknown>).message
  return typeof message === "string" && message.trim() ? message.trim() : fallback
}

export async function POST(request: Request) {
  try {
    await requireSpcPagePermission("spc-readme", "edit")
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.")

    const payload = (await request.json()) as GeneratePayload
    const input = cleanInput(payload.input, 4096)
    if (!input) return NextResponse.json({ message: "Input is required." }, { status: 400 })

    if (payload.action === "response") {
      const model = process.env.OPENAI_ADMIN_MODEL || "gpt-5.4-mini"
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          instructions: [
            "Respond as a practical workflow adviser for an educational demonstration.",
            "Use clear headings and concise operational language.",
            "Respect every constraint in the user's prompt.",
            "Do not claim certainty about facts that were not supplied.",
            "Keep the complete answer below 650 words.",
          ].join("\n"),
          input,
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        return NextResponse.json(
          { message: providerMessage(result, "OpenAI response generation failed.") },
          { status: response.status },
        )
      }
      const output = extractOutputText(result)
      if (!output) throw new Error("OpenAI returned no response text.")
      return NextResponse.json({
        model,
        responseId: typeof result.id === "string" ? result.id : null,
        output,
      })
    }

    if (payload.action === "speech") {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice: "marin",
          input,
          instructions: [
            "Speak in natural, polished British English.",
            "Use a calm and confident corporate presentation tone.",
            "Keep a deliberate educational pace with short pauses between ideas.",
            "Sound conversational and engaged, never theatrical or promotional.",
            "Clearly pronounce IMO as I-M-O, AI as A-I, and WhatsApp as WhatsApp.",
          ].join(" "),
          response_format: "mp3",
          speed: 0.94,
        }),
      })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        return NextResponse.json(
          { message: providerMessage(result, "OpenAI speech generation failed.") },
          { status: response.status },
        )
      }
      return new Response(await response.arrayBuffer(), {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "audio/mpeg",
        },
      })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
