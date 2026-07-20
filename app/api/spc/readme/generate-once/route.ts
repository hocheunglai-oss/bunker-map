import { timingSafeEqual } from "node:crypto"

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type SpeechPayload = {
  action?: "speech"
  input?: string
  speed?: number
}

function matchesSecret(supplied: string | null, expected: string | undefined) {
  if (!supplied || !expected) return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
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
    if (!matchesSecret(request.headers.get("x-presentation-generation-token"), process.env.SUPABASE_SERVICE_ROLE_KEY)) {
      return NextResponse.json({ message: "Not found." }, { status: 404 })
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.")

    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const payload = await request.formData()
      const file = payload.get("file")
      if (payload.get("action") !== "transcribe" || !(file instanceof File)) {
        return NextResponse.json({ message: "A transcription file is required." }, { status: 400 })
      }

      const form = new FormData()
      form.append("file", file, file.name || "presentation-audio.mp3")
      form.append("model", "whisper-1")
      form.append("response_format", "verbose_json")
      form.append("timestamp_granularities[]", "word")
      form.append("language", "en")
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) return NextResponse.json({ message: providerMessage(result, "OpenAI transcription failed.") }, { status: response.status })
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } })
    }

    const payload = (await request.json()) as SpeechPayload
    const input = typeof payload.input === "string" ? payload.input.trim().slice(0, 4096) : ""
    const speed = Number.isFinite(payload.speed) ? Math.min(1, Math.max(.75, Number(payload.speed))) : .82
    if (!input) return NextResponse.json({ message: "Input is required." }, { status: 400 })
    if (payload.action !== "speech") return NextResponse.json({ message: "Unsupported action." }, { status: 400 })

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "marin",
        speed,
        response_format: "flac",
        input,
        instructions: [
          "Read the supplied script verbatim. Do not omit, add, paraphrase, merge, or replace any word.",
          "Use one fixed adult female Marin speaker identity for the entire recording.",
          "Keep the same age, accent, pitch, vocal timbre, energy, microphone distance, and volume from the first word to the last.",
          "Speak in calm, polished British English for an international boardroom audience, including listeners who are not native English speakers.",
          "Maintain one steady educational pace of approximately 125 to 130 spoken words per minute.",
          "Use clear, deliberate diction and full consonants. Keep the delivery warm, natural, and professional.",
          "Do not accelerate lists, later paragraphs, or the final section.",
          "Pause naturally at full stops and use a slightly longer pause between paragraphs.",
          "Do not use dramatic, promotional, theatrical, or conversational voice changes.",
          "Pronounce the word screen with a clear final N consonant. Never pronounce it as scream.",
          "Pronounce A-I, S-P-C, and I-M-O as individual letters, and pronounce WhatsApp normally.",
        ].join(" "),
      }),
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({}))
      return NextResponse.json({ message: providerMessage(result, "OpenAI speech generation failed.") }, { status: response.status })
    }
    return new Response(await response.arrayBuffer(), { headers: { "Cache-Control": "private, no-store", "Content-Type": "audio/flac" } })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed."
    return NextResponse.json({ message }, { status: 500 })
  }
}
