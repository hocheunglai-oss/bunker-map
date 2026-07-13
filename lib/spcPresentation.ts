import { createClient } from "@supabase/supabase-js"
import type { SpcSession } from "@/lib/spcAuth"
import {
  createSpcAuditContext,
  createSpcAuditedSupabaseClient,
  type SpcAuditContext,
} from "@/lib/spcAudit"

const PRESENTATION_TABLE = "spc_presentation_chunks"
const PRESENTATION_BUCKET = "spc-presentation-media"
const SIGNED_MEDIA_SECONDS = 8 * 60 * 60
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const MAX_NARRATION_BYTES = 50 * 1024 * 1024
const OPENAI_AUDIO_MODEL = "gpt-audio-1.5"
const OPENAI_AUDIO_VOICE = "marin"
const OPENAI_AUDIO_INSTRUCTIONS = [
  "You are a calm, experienced bunker-trading trainer presenting to colleagues in a room.",
  "Read the supplied narration script verbatim and return only that spoken narration.",
  "Never add an introduction, conclusion, stage direction, or explanatory wording.",
  "Use natural international English with subtle warmth, varied intonation, and a relaxed conversational rhythm.",
  "Pause briefly between ideas and breathe naturally instead of rushing to fill silence.",
  "Sound thoughtful and confident, not promotional, theatrical, robotic, or like a news announcer.",
  "Give gentle emphasis to operational risks and human verification.",
  "Pronounce AI as A-I, SPC as S-P-C, IMO as I-M-O, and fuel-grade abbreviations letter by letter.",
].join(" ")

const PRESENTATION_COLUMNS = [
  "id",
  "slug",
  "sort_order",
  "section_label",
  "title",
  "summary",
  "narration",
  "key_points",
  "q_and_a_prompt",
  "visual_kind",
  "video_path",
  "video_mime_type",
  "video_bytes",
  "narration_path",
  "narration_mime_type",
  "narration_bytes",
  "duration_seconds",
  "media_version",
  "revision",
  "status",
  "created_by_username",
  "updated_by_username",
  "created_at",
  "updated_at",
].join(",")

type PresentationRow = {
  id: string
  slug: string
  sort_order: number
  section_label: string
  title: string
  summary: string
  narration: string
  key_points: string[] | null
  q_and_a_prompt: string
  visual_kind: string
  video_path: string | null
  video_mime_type: string | null
  video_bytes: number | string | null
  narration_path: string | null
  narration_mime_type: string | null
  narration_bytes: number | string | null
  duration_seconds: number | null
  media_version: number
  revision: number
  status: "draft" | "published"
  created_by_username: string | null
  updated_by_username: string | null
  created_at: string
  updated_at: string
}

export type SpcPresentationChunk = {
  id: string
  slug: string
  sortOrder: number
  sectionLabel: string
  title: string
  summary: string
  narration: string
  keyPoints: string[]
  questionPrompt: string
  visualKind: string
  videoUrl: string | null
  videoMimeType: string | null
  videoBytes: number
  narrationUrl: string | null
  narrationMimeType: string | null
  narrationBytes: number
  narrationIsAi: boolean
  durationSeconds: number | null
  mediaVersion: number
  revision: number
  status: "draft" | "published"
  updatedAt: string
}

export type SaveSpcPresentationChunkInput = {
  id?: string
  revision?: number
  sectionLabel?: string
  title?: string
  summary?: string
  narration?: string
  keyPoints?: string[]
  questionPrompt?: string
  visualKind?: string
  durationSeconds?: number | null
  status?: "draft" | "published"
}

export type PresentationUploadKind = "video" | "narration"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function presentationClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  )
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function cleanVisualKind(value: unknown) {
  const clean = cleanText(value, 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-")
  return clean.replace(/^-+|-+$/g, "") || "video"
}

function cleanKeyPoints(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => cleanText(item, 220))
    .filter(Boolean)
    .slice(0, 8)
}

function cleanDuration(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(Math.max(Math.round(number), 0), 3600)
}

function safeSlug(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return slug || `chunk-${Date.now()}`
}

function safeFileName(value: string) {
  const dot = value.lastIndexOf(".")
  const extension = dot >= 0 ? value.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : ""
  const base = (dot >= 0 ? value.slice(0, dot) : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return `${base || "media"}${extension.slice(0, 10)}`
}

function bytes(value: number | string | null) {
  const number = Number(value || 0)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

function narrationWords(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) || []
}

function narrationTranscriptCoverage(script: string, transcript: string) {
  const expected = narrationWords(script)
  const spoken = narrationWords(transcript)
  if (expected.length === 0 || spoken.length === 0) return 0

  const available = new Map<string, number>()
  for (const word of spoken) available.set(word, (available.get(word) || 0) + 1)

  let matched = 0
  for (const word of expected) {
    const remaining = available.get(word) || 0
    if (remaining > 0) {
      matched += 1
      available.set(word, remaining - 1)
    }
  }
  return matched / Math.max(expected.length, spoken.length)
}

async function createSignedMediaUrls(rows: PresentationRow[]) {
  const paths = Array.from(
    new Set(
      rows.flatMap((row) => [row.video_path, row.narration_path]).filter(
        (path): path is string => typeof path === "string" && Boolean(path),
      ),
    ),
  )
  const urls = new Map<string, string>()
  if (paths.length === 0) return urls

  const { data, error } = await presentationClient()
    .storage
    .from(PRESENTATION_BUCKET)
    .createSignedUrls(paths, SIGNED_MEDIA_SECONDS)
  if (error) throw new Error(`Could not prepare presentation media: ${error.message}`)
  for (const item of data || []) {
    if (item.path && item.signedUrl) urls.set(item.path, item.signedUrl)
  }
  return urls
}

function presentRow(row: PresentationRow, mediaUrls: Map<string, string>): SpcPresentationChunk {

  return {
    id: row.id,
    slug: row.slug,
    sortOrder: row.sort_order,
    sectionLabel: row.section_label,
    title: row.title,
    summary: row.summary,
    narration: row.narration,
    keyPoints: row.key_points || [],
    questionPrompt: row.q_and_a_prompt,
    visualKind: row.visual_kind,
    videoUrl: row.video_path ? mediaUrls.get(row.video_path) || null : null,
    videoMimeType: row.video_mime_type,
    videoBytes: bytes(row.video_bytes),
    narrationUrl: row.narration_path ? mediaUrls.get(row.narration_path) || null : null,
    narrationMimeType: row.narration_mime_type,
    narrationBytes: bytes(row.narration_bytes),
    narrationIsAi: Boolean(row.narration_path?.includes("-openai-")),
    durationSeconds: row.duration_seconds,
    mediaVersion: row.media_version,
    revision: row.revision,
    status: row.status,
    updatedAt: row.updated_at,
  }
}

export async function listSpcPresentationChunks(includeDrafts: boolean) {
  let query = presentationClient()
    .from(PRESENTATION_TABLE)
    .select(PRESENTATION_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })

  if (!includeDrafts) query = query.eq("status", "published")

  const { data, error } = await query
  if (error) throw new Error(`Could not load presentation chunks: ${error.message}`)
  const rows = (data || []) as unknown as PresentationRow[]
  const mediaUrls = await createSignedMediaUrls(rows)
  return rows.map((row) => presentRow(row, mediaUrls))
}

async function presentSingleRow(row: PresentationRow) {
  return presentRow(row, await createSignedMediaUrls([row]))
}

function savePayload(input: SaveSpcPresentationChunkInput, username: string) {
  const title = cleanText(input.title, 140)
  if (!title) throw new Error("Chunk title is required.")

  return {
    section_label: cleanText(input.sectionLabel, 40) || "CHAPTER",
    title,
    summary: cleanText(input.summary, 700),
    narration: cleanText(input.narration, 7000),
    key_points: cleanKeyPoints(input.keyPoints),
    q_and_a_prompt: cleanText(input.questionPrompt, 500),
    visual_kind: cleanVisualKind(input.visualKind),
    duration_seconds: cleanDuration(input.durationSeconds),
    status: input.status === "draft" ? "draft" : "published",
    updated_by_username: username,
  }
}

export async function saveSpcPresentationChunk(
  input: SaveSpcPresentationChunkInput,
  context: SpcAuditContext,
) {
  const client = createSpcAuditedSupabaseClient(context)
  const payload = savePayload(input, context.username)

  if (!input.id) {
    const { data: lastRow, error: orderError } = await presentationClient()
      .from(PRESENTATION_TABLE)
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (orderError) throw new Error(`Could not determine chunk order: ${orderError.message}`)

    const slugBase = safeSlug(payload.title)
    const slug = `${slugBase}-${Date.now().toString(36)}`
    const { data, error } = await client
      .from(PRESENTATION_TABLE)
      .insert({
        ...payload,
        slug,
        sort_order: Number(lastRow?.sort_order || 0) + 10,
        created_by_username: context.username,
      })
      .select(PRESENTATION_COLUMNS)
      .single()
    if (error) throw new Error(`Could not create presentation chunk: ${error.message}`)
    return presentSingleRow(data as unknown as PresentationRow)
  }

  const revision = Math.max(Number(input.revision || 0), 1)
  const { data, error } = await client
    .from(PRESENTATION_TABLE)
    .update({ ...payload, revision: revision + 1 })
    .eq("id", input.id)
    .eq("revision", revision)
    .select(PRESENTATION_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(`Could not save presentation chunk: ${error.message}`)
  if (!data) throw new Error("This chunk changed in another session. Refresh before saving again.")
  return presentSingleRow(data as unknown as PresentationRow)
}

export async function moveSpcPresentationChunk(
  id: string,
  direction: "earlier" | "later",
  context: SpcAuditContext,
) {
  const { data, error } = await presentationClient()
    .from(PRESENTATION_TABLE)
    .select("id,sort_order,revision")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
  if (error) throw new Error(`Could not load chunk order: ${error.message}`)

  const rows = (data || []) as Array<{ id: string; sort_order: number; revision: number }>
  const index = rows.findIndex((row) => row.id === id)
  const neighborIndex = direction === "earlier" ? index - 1 : index + 1
  if (index < 0 || neighborIndex < 0 || neighborIndex >= rows.length) {
    return listSpcPresentationChunks(true)
  }

  const row = rows[index]
  const neighbor = rows[neighborIndex]
  const nextOrder = neighbor.sort_order + (direction === "earlier" ? -1 : 1)
  const { data: updated, error: updateError } = await createSpcAuditedSupabaseClient(context)
    .from(PRESENTATION_TABLE)
    .update({
      sort_order: nextOrder,
      revision: row.revision + 1,
      updated_by_username: context.username,
    })
    .eq("id", id)
    .eq("revision", row.revision)
    .select("id")
    .maybeSingle()
  if (updateError) throw new Error(`Could not move presentation chunk: ${updateError.message}`)
  if (!updated) throw new Error("This chunk changed in another session. Refresh before moving it.")
  return listSpcPresentationChunks(true)
}

export async function deleteSpcPresentationChunk(id: string, context: SpcAuditContext) {
  const { data: row, error } = await presentationClient()
    .from(PRESENTATION_TABLE)
    .select("video_path,narration_path")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`Could not load presentation chunk: ${error.message}`)
  if (!row) throw new Error("Presentation chunk was not found.")

  const { error: deleteError } = await createSpcAuditedSupabaseClient(context)
    .from(PRESENTATION_TABLE)
    .delete()
    .eq("id", id)
  if (deleteError) throw new Error(`Could not delete presentation chunk: ${deleteError.message}`)

  const paths = [row.video_path, row.narration_path].filter(
    (path): path is string => typeof path === "string" && Boolean(path),
  )
  if (paths.length > 0) {
    await presentationClient().storage.from(PRESENTATION_BUCKET).remove(paths)
  }
}

async function ensurePresentationBucket() {
  const client = presentationClient()
  const { data, error } = await client.storage.getBucket(PRESENTATION_BUCKET)
  if (data && !error) return

  const { error: createError } = await client.storage.createBucket(PRESENTATION_BUCKET, {
    public: false,
    fileSizeLimit: MAX_VIDEO_BYTES,
    allowedMimeTypes: [
      "video/mp4",
      "video/webm",
      "audio/mpeg",
      "audio/mp4",
      "audio/wav",
      "audio/x-wav",
      "audio/webm",
    ],
  })
  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw new Error(`Could not prepare presentation storage: ${createError.message}`)
  }
}

export async function prepareSpcPresentationUpload(
  id: string,
  kind: PresentationUploadKind,
  fileName: string,
  mimeType: string,
  fileBytes: number,
) {
  const maxBytes = kind === "video" ? MAX_VIDEO_BYTES : MAX_NARRATION_BYTES
  if (!Number.isFinite(fileBytes) || fileBytes <= 0 || fileBytes > maxBytes) {
    throw new Error(
      kind === "video"
        ? "Video must be smaller than 50 MB."
        : "Narration must be smaller than 50 MB.",
    )
  }
  const validMime = kind === "video" ? mimeType.startsWith("video/") : mimeType.startsWith("audio/")
  if (!validMime) throw new Error(`Select a valid ${kind} file.`)

  const { data: chunk, error } = await presentationClient()
    .from(PRESENTATION_TABLE)
    .select("id")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`Could not load presentation chunk: ${error.message}`)
  if (!chunk) throw new Error("Presentation chunk was not found.")

  await ensurePresentationBucket()
  const path = `${id}/${kind}-${Date.now()}-${safeFileName(fileName)}`
  const { data, error: signError } = await presentationClient()
    .storage
    .from(PRESENTATION_BUCKET)
    .createSignedUploadUrl(path)
  if (signError) throw new Error(`Could not prepare media upload: ${signError.message}`)
  return { bucket: PRESENTATION_BUCKET, path, token: data.token, signedUrl: data.signedUrl }
}

export async function completeSpcPresentationUpload(
  id: string,
  revision: number,
  kind: PresentationUploadKind,
  path: string,
  mimeType: string,
  context: SpcAuditContext,
) {
  if (!path.startsWith(`${id}/${kind}-`)) throw new Error("Invalid presentation media path.")
  const client = presentationClient()
  const { data: current, error } = await client
    .from(PRESENTATION_TABLE)
    .select("video_path,narration_path,media_version,revision")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`Could not load presentation chunk: ${error.message}`)
  if (!current) throw new Error("Presentation chunk was not found.")
  if (Number(current.revision) !== revision) {
    throw new Error("This chunk changed in another session. Refresh before attaching media.")
  }

  const fileName = path.split("/").pop() || ""
  const { data: files, error: listError } = await client.storage
    .from(PRESENTATION_BUCKET)
    .list(id, { search: fileName, limit: 10 })
  if (listError) throw new Error(`Could not verify uploaded media: ${listError.message}`)
  const file = (files || []).find((entry) => entry.name === fileName)
  if (!file) throw new Error("The uploaded media could not be verified.")

  const fileBytes = bytes((file.metadata as { size?: number } | null)?.size || 0)
  const columns =
    kind === "video"
      ? { video_path: path, video_mime_type: mimeType, video_bytes: fileBytes }
      : { narration_path: path, narration_mime_type: mimeType, narration_bytes: fileBytes }
  const { data: updated, error: updateError } = await createSpcAuditedSupabaseClient(context)
    .from(PRESENTATION_TABLE)
    .update({
      ...columns,
      media_version: Number(current.media_version) + 1,
      revision: revision + 1,
      updated_by_username: context.username,
    })
    .eq("id", id)
    .eq("revision", revision)
    .select(PRESENTATION_COLUMNS)
    .maybeSingle()
  if (updateError) throw new Error(`Could not attach presentation media: ${updateError.message}`)
  if (!updated) throw new Error("This chunk changed in another session. Refresh before attaching media.")

  const previousPath = kind === "video" ? current.video_path : current.narration_path
  if (previousPath && previousPath !== path) {
    await client.storage.from(PRESENTATION_BUCKET).remove([previousPath])
  }
  return presentSingleRow(updated as unknown as PresentationRow)
}

export async function generateSpcPresentationNarration(
  id: string,
  revision: number,
  context: SpcAuditContext,
) {
  const client = presentationClient()
  const { data: current, error } = await client
    .from(PRESENTATION_TABLE)
    .select(PRESENTATION_COLUMNS)
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`Could not load presentation chunk: ${error.message}`)
  if (!current) throw new Error("Presentation chunk was not found.")

  const row = current as unknown as PresentationRow
  if (row.revision !== revision) {
    throw new Error("This chunk changed in another session. Refresh before generating narration.")
  }
  const narration = row.narration.trim()
  if (!narration) throw new Error("Add and save a narration script before generating its voice.")
  const targetDuration = row.duration_seconds
    ? `Aim for a natural total duration close to ${row.duration_seconds} seconds without changing or rushing the script.`
    : "Use a slow, clear presentation pace of roughly 120 words per minute."
  const speechResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_AUDIO_MODEL,
      modalities: ["text", "audio"],
      audio: { voice: OPENAI_AUDIO_VOICE, format: "mp3" },
      messages: [
        {
          role: "developer",
          content: `${OPENAI_AUDIO_INSTRUCTIONS} ${targetDuration}`,
        },
        {
          role: "user",
          content: `Read only the narration between the SCRIPT markers.\n\nSCRIPT\n${narration}\nEND SCRIPT`,
        },
      ],
    }),
    signal: AbortSignal.timeout(110_000),
  })
  if (!speechResponse.ok) {
    const details = (await speechResponse.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null
    throw new Error(details?.error?.message || "OpenAI could not generate narration.")
  }

  const speech = (await speechResponse.json()) as {
    choices?: Array<{
      message?: { audio?: { data?: string; transcript?: string } | null }
    }>
  }
  const generated = speech.choices?.[0]?.message?.audio
  const transcript = generated?.transcript?.trim() || ""
  if (!generated?.data || narrationTranscriptCoverage(narration, transcript) < 0.9) {
    throw new Error("The generated voice did not preserve enough of the saved script. Please generate it again.")
  }

  const audio = new Uint8Array(Buffer.from(generated.data, "base64"))
  if (audio.byteLength <= 0 || audio.byteLength > MAX_NARRATION_BYTES) {
    throw new Error("OpenAI returned an invalid narration file.")
  }

  await ensurePresentationBucket()
  const path = `${id}/narration-${Date.now()}-openai-${OPENAI_AUDIO_MODEL}-${OPENAI_AUDIO_VOICE}.mp3`
  const { error: uploadError } = await client.storage
    .from(PRESENTATION_BUCKET)
    .upload(path, audio, { contentType: "audio/mpeg", upsert: false })
  if (uploadError) throw new Error(`Could not store generated narration: ${uploadError.message}`)

  const { data: updated, error: updateError } = await createSpcAuditedSupabaseClient(context)
    .from(PRESENTATION_TABLE)
    .update({
      narration_path: path,
      narration_mime_type: "audio/mpeg",
      narration_bytes: audio.byteLength,
      media_version: row.media_version + 1,
      revision: revision + 1,
      updated_by_username: context.username,
    })
    .eq("id", id)
    .eq("revision", revision)
    .select(PRESENTATION_COLUMNS)
    .maybeSingle()

  if (updateError || !updated) {
    await client.storage.from(PRESENTATION_BUCKET).remove([path])
    if (updateError) throw new Error(`Could not attach generated narration: ${updateError.message}`)
    throw new Error("This chunk changed while narration was being generated. Refresh and try again.")
  }

  if (row.narration_path && row.narration_path !== path) {
    await client.storage.from(PRESENTATION_BUCKET).remove([row.narration_path])
  }
  return presentSingleRow(updated as unknown as PresentationRow)
}

export function createPresentationContext(session: SpcSession, request: Request) {
  return createSpcAuditContext(session, request, "spc-readme")
}
