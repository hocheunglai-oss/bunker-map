import { NextResponse } from "next/server"

import { requireSpcPagePermission } from "@/lib/spcAuth"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type GeneratePayload = {
  action?: "speech"
  input?: string
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
    const input = typeof payload.input === "string" ? payload.input.trim().slice(0, 4096) : ""
    if (!input) return NextResponse.json({ message: "Input is required." }, { status: 400 })
    if (payload.action !== "speech") return NextResponse.json({ message: "Unsupported action." }, { status: 400 })

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
          "Use the same Marin speaker identity as every other segment in this presentation.",
          "Keep pitch, vocal timbre, energy, microphone distance, and pace consistent from beginning to end.",
          "Speak in natural, polished British English with a calm, clear corporate presentation tone.",
          "Address an international audience at a listener-friendly educational pace.",
          "Use short natural sentence pauses, with no long, dramatic, theatrical, or promotional delivery.",
          "Read connected points as one continuous explanation rather than restarting the voice for each sentence.",
          "Articulate every commercial term distinctly.",
          "Clearly pronounce AI as A-I, SPC as S-P-C, IMO as I-M-O, and WhatsApp as WhatsApp.",
        ].join(" "),
        response_format: "mp3",
        speed: 0.94,
      }),
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({}))
      return NextResponse.json({ message: providerMessage(result, "OpenAI speech generation failed.") }, { status: response.status })
    }

    return new Response(await response.arrayBuffer(), {
      headers: { "Cache-Control": "private, no-store", "Content-Type": "audio/mpeg" },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
