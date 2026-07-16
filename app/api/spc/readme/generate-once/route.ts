import { NextResponse } from "next/server"

import { requireSpcPagePermission } from "@/lib/spcAuth"

export const dynamic = "force-dynamic"
export const maxDuration = 60

type SpeechPayload = {
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

    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const payload = await request.formData()
      const file = payload.get("file")
      if (payload.get("action") !== "transcribe" || !(file instanceof File)) {
        return NextResponse.json({ message: "A transcription file is required." }, { status: 400 })
      }
      const form = new FormData()
      form.append("file", file, file.name || "chapter-1.mp3")
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
          "Use one fixed adult female Marin speaker identity for the entire recording.",
          "This is one continuous studio session. Never change age, gender, pitch, timbre, accent, energy, or microphone distance.",
          "Match the calm, warm, deliberate pace of the presentation introduction.",
          "Speak in natural, polished British English for an international audience.",
          "Use simple educational delivery with a clear pause between ideas.",
          "Do not sound theatrical, promotional, urgent, or excited.",
          "Articulate bunker-trading terms clearly.",
          "Pronounce A-I, S-P-C, and I-M-O as individual letters, and pronounce WhatsApp normally.",
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
