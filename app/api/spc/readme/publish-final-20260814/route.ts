import { createHash, timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

const CHUNK_ID = "533d5a43-c8f7-4b81-9fc7-b03b27f82860"
const EXPECTED_BYTES = 28_071_399
const EXPECTED_SHA256 = "3bbe21551e17682b29fcc378832766f52675cefacb52b1b62ecc829334c919b1"
const EXPECTED_NARRATION_SHA256 = "80888526f51226c39b5fe81b6cbc9b5a5a3d3c72d46c16442e313d509e1137fa"
const PUBLISH_TOKEN_SHA256 = "6eadea769e2b564e622d0d57ce3df3ff5d29a0a57f06712abc024663a706479a"
const EXPIRES_AT = Date.parse("2026-08-15T04:00:00Z")
const MEDIA_PATH = `${CHUNK_ID}/video-20260814-human-boundary-synced.mp4`
const MEDIA_URL =
  "https://github.com/hocheunglai-oss/bunker-map/releases/download/spc-presentation-final-20260814-human-boundary/incorporate-ai-trading-final-chapter-complete-synced.mp4"
const BUCKET = "spc-presentation-media"

type PublishPayload = {
  expectedRevision?: number
  narration?: string
}

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function presentationClient() {
  return createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  )
}

function authorized(request: Request) {
  if (Date.now() > EXPIRES_AT) return false
  const supplied = createHash("sha256")
    .update(request.headers.get("x-spc-publish-token") || "")
    .digest()
  const expected = Buffer.from(PUBLISH_TOKEN_SHA256, "hex")
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ message: "Not found." }, { status: 404 })
  try {
    const client = presentationClient()
    const { data: chunk, error } = await client
      .from("spc_presentation_chunks")
      .select(
        "id,chapter_label,section_label,title,duration_seconds,revision,media_version,video_path,video_mime_type,video_bytes,status,updated_at",
      )
      .eq("id", CHUNK_ID)
      .maybeSingle()
    if (error) throw error
    if (!chunk) return NextResponse.json({ message: "Final chapter not found." }, { status: 404 })
    return NextResponse.json({ success: true, chunk })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not inspect final chapter."
    return NextResponse.json({ message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ message: "Not found." }, { status: 404 })
  try {
    const payload = (await request.json()) as PublishPayload
    const expectedRevision = Number(payload.expectedRevision || 0)
    const narration = String(payload.narration || "").trim()
    if (!expectedRevision || !narration) {
      return NextResponse.json({ message: "Revision and narration are required." }, { status: 400 })
    }
    if (createHash("sha256").update(`${narration}\n`).digest("hex") !== EXPECTED_NARRATION_SHA256) {
      return NextResponse.json({ message: "Narration digest mismatch." }, { status: 400 })
    }

    const client = presentationClient()
    const { data: current, error: currentError } = await client
      .from("spc_presentation_chunks")
      .select("id,revision,media_version,video_path,narration_path")
      .eq("id", CHUNK_ID)
      .maybeSingle()
    if (currentError) throw currentError
    if (!current) throw new Error("Final chapter not found.")
    if (Number(current.revision) !== expectedRevision) {
      return NextResponse.json(
        {
          message: "Final chapter changed after inspection.",
          expectedRevision,
          actualRevision: current.revision,
        },
        { status: 409 },
      )
    }

    const mediaResponse = await fetch(MEDIA_URL, { cache: "no-store" })
    if (!mediaResponse.ok) throw new Error(`Media download failed: HTTP ${mediaResponse.status}`)
    const media = new Uint8Array(await mediaResponse.arrayBuffer())
    if (media.byteLength !== EXPECTED_BYTES) {
      throw new Error(`Media size mismatch: ${media.byteLength}`)
    }
    const digest = createHash("sha256").update(media).digest("hex")
    if (digest !== EXPECTED_SHA256) throw new Error(`Media digest mismatch: ${digest}`)

    const { error: uploadError } = await client.storage.from(BUCKET).upload(MEDIA_PATH, media, {
      contentType: "video/mp4",
      cacheControl: "3600",
      upsert: true,
    })
    if (uploadError) throw uploadError

    const { data: files, error: listError } = await client.storage
      .from(BUCKET)
      .list(CHUNK_ID, { search: MEDIA_PATH.split("/").pop(), limit: 2 })
    if (listError) throw listError
    const uploaded = (files || []).find((file) => `${CHUNK_ID}/${file.name}` === MEDIA_PATH)
    const uploadedBytes = Number(
      (uploaded?.metadata as { size?: number } | null | undefined)?.size || 0,
    )
    if (!uploaded || uploadedBytes !== EXPECTED_BYTES) {
      await client.storage.from(BUCKET).remove([MEDIA_PATH])
      throw new Error(`Stored media verification failed: ${uploadedBytes}`)
    }

    const { data: updated, error: updateError } = await client
      .from("spc_presentation_chunks")
      .update({
        chapter_label: "FINAL CHAPTER: WHAT COMES NEXT?",
        section_label: "WHAT COMES NEXT?",
        title: "WHAT COMES NEXT?",
        summary:
          "Practical next steps for group-wide AI capability, responsible research and development, and the future role of bunker traders.",
        narration,
        key_points: [],
        q_and_a_prompt: "",
        visual_kind: "video",
        duration_seconds: 288.46,
        video_path: MEDIA_PATH,
        video_mime_type: "video/mp4",
        video_bytes: EXPECTED_BYTES,
        narration_path: null,
        narration_mime_type: null,
        narration_bytes: null,
        media_version: Number(current.media_version) + 1,
        revision: expectedRevision + 1,
        status: "published",
        updated_by_username: "Codex",
      })
      .eq("id", CHUNK_ID)
      .eq("revision", expectedRevision)
      .select(
        "id,chapter_label,section_label,title,duration_seconds,revision,media_version,video_path,video_mime_type,video_bytes,narration_path,status,updated_at",
      )
      .maybeSingle()
    if (updateError || !updated) {
      await client.storage.from(BUCKET).remove([MEDIA_PATH])
      throw updateError || new Error("Final chapter changed during publication.")
    }

    const previousPaths = [current.video_path, current.narration_path].filter(
      (value): value is string => typeof value === "string" && value.length > 0 && value !== MEDIA_PATH,
    )
    if (previousPaths.length) {
      const { error: removalError } = await client.storage.from(BUCKET).remove(previousPaths)
      if (removalError) console.warn(`Old media cleanup failed: ${removalError.message}`)
    }

    return NextResponse.json({ success: true, chunk: updated, sha256: digest })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not publish final chapter."
    return NextResponse.json({ message }, { status: 500 })
  }
}
