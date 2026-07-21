import { createHash, timingSafeEqual } from "node:crypto"

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TOKEN_DIGEST = "08643408124a5cf7f91c9b7d3420d03eb3561d920cdd158ce22b75d20fbc10e8"
const EXPIRES_AT = Date.parse("2026-07-23T23:59:00+08:00")

type SpeechPayload = {
  action?: "speech"
  input?: string
  speed?: number
}

function authorised(request: Request) {
  if (Date.now() > EXPIRES_AT) return false
  const supplied = request.headers.get("x-presentation-generation-token") || ""
  const actual = createHash("sha256").update(supplied).digest()
  const expected = Buffer.from(TOKEN_DIGEST, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
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
    if (!authorised(request)) return NextResponse.json({ message: "Not found." }, { status: 404 })
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
      if (!response.ok) {
        return NextResponse.json({ message: providerMessage(result, "OpenAI transcription failed.") }, { status: response.status })
      }
      return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } })
    }

    const payload = (await request.json()) as SpeechPayload
    const input = typeof payload.input === "string" ? payload.input.trim().slice(0, 6000) : ""
    const speed = Number.isFinite(payload.speed) ? Math.min(1, Math.max(0.75, Number(payload.speed))) : 0.82
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
          "Read every supplied word verbatim from beginning to end.",
          "Never omit, merge, paraphrase, replace, or truncate a sentence.",
          "Use one fixed adult female Marin speaker identity with polished British English.",
          "Keep the same age, accent, pitch, timbre, energy, microphone distance, and volume throughout the entire chapter.",
          "Speak clearly for an international boardroom audience whose first language may not be English.",
          "Maintain a calm educational pace of approximately 125 to 130 words per minute.",
          "Use full consonants, complete every sentence, and make every number unambiguous.",
          "Do not accelerate lists, later paragraphs, or the closing lines.",
          "Pause naturally at full stops and slightly longer between paragraphs.",
          "Do not use dramatic, promotional, theatrical, or conversational voice changes.",
          "Pronounce A-I, S-P-C, and I-M-O as individual letters, and pronounce WhatsApp normally.",
        ].join(" "),
      }),
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({}))
      return NextResponse.json({ message: providerMessage(result, "OpenAI speech generation failed.") }, { status: response.status })
    }
    return new Response(await response.arrayBuffer(), {
      headers: { "Cache-Control": "private, no-store", "Content-Type": "audio/flac" },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed."
    return NextResponse.json({ message }, { status: 500 })
  }
}
