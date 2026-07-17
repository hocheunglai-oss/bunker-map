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
const MAX_VISUAL_COPY_ITEMS = 120

const PRESENTATION_COLUMNS = [
  "id",
  "slug",
  "sort_order",
  "chapter_label",
  "section_label",
  "title",
  "summary",
  "narration",
  "key_points",
  "q_and_a_prompt",
  "visual_kind",
  "visual_copy",
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
  chapter_label: string
  section_label: string
  title: string
  summary: string
  narration: string
  key_points: string[] | null
  q_and_a_prompt: string
  visual_kind: string
  visual_copy: unknown
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

export type SpcPresentationVisualText = {
  id: string
  label: string
  text: string
}

export type SpcPresentationChunk = {
  id: string
  slug: string
  sortOrder: number
  chapterLabel: string
  sectionLabel: string
  title: string
  summary: string
  narration: string
  keyPoints: string[]
  questionPrompt: string
  visualKind: string
  visualCopy: SpcPresentationVisualText[]
  videoUrl: string | null
  videoMimeType: string | null
  videoBytes: number
  videoHasEmbeddedAudio: boolean
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
  chapterLabel?: string
  sectionLabel?: string
  title?: string
  summary?: string
  narration?: string
  keyPoints?: string[]
  questionPrompt?: string
  visualKind?: string
  visualCopy?: SpcPresentationVisualText[]
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

function cleanVisualCopy(value: unknown): SpcPresentationVisualText[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const items: SpcPresentationVisualText[] = []

  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const id = cleanText(record.id, 80)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
    if (!id || seen.has(id)) continue
    const label = cleanText(record.label, 100) || id.replace(/-/g, " ").toUpperCase()
    const text = typeof record.text === "string" ? record.text.trim().slice(0, 8000) : ""
    seen.add(id)
    items.push({ id, label, text })
    if (items.length >= MAX_VISUAL_COPY_ITEMS) break
  }
  return items
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
    chapterLabel: row.chapter_label,
    sectionLabel: row.section_label,
    title: row.title,
    summary: row.summary,
    narration: row.narration,
    keyPoints: row.key_points || [],
    questionPrompt: row.q_and_a_prompt,
    visualKind: row.visual_kind,
    visualCopy: cleanVisualCopy(row.visual_copy),
    videoUrl: row.video_path ? mediaUrls.get(row.video_path) || null : null,
    videoMimeType: row.video_mime_type,
    videoBytes: bytes(row.video_bytes),
    videoHasEmbeddedAudio: /(?:^|[-_])synced\.(?:mp4|webm)$/i.test(row.video_path || ""),
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
  if (error) throw new Error(`Could not load presentation sections: ${error.message}`)
  const rows = (data || []) as unknown as PresentationRow[]
  const mediaUrls = await createSignedMediaUrls(rows)
  return rows.map((row) => presentRow(row, mediaUrls))
}

async function presentSingleRow(row: PresentationRow) {
  return presentRow(row, await createSignedMediaUrls([row]))
}

function savePayload(input: SaveSpcPresentationChunkInput, username: string) {
  const title = cleanText(input.title, 140)
  if (!title) throw new Error("Section title is required.")

  return {
    chapter_label: cleanText(input.chapterLabel, 40) || "CHAPTER 1",
    section_label: cleanText(input.sectionLabel, 40) || "CHAPTER",
    title,
    summary: cleanText(input.summary, 700),
    narration: cleanText(input.narration, 7000),
    key_points: cleanKeyPoints(input.keyPoints),
    q_and_a_prompt: cleanText(input.questionPrompt, 500),
    visual_kind: cleanVisualKind(input.visualKind),
    visual_copy: cleanVisualCopy(input.visualCopy),
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
    if (orderError) throw new Error(`Could not determine section order: ${orderError.message}`)

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
    if (error) throw new Error(`Could not create presentation section: ${error.message}`)
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
  if (error) throw new Error(`Could not save presentation section: ${error.message}`)
  if (!data) throw new Error("This section changed in another session. Refresh before saving again.")
  return presentSingleRow(data as unknown as PresentationRow)
}

export async function moveSpcPresentationChunk(
  id: string,
  direction: "earlier" | "later",
  context: SpcAuditContext,
) {
  const { data, error } = await presentationClient()
    .from(PRESENTATION_TABLE)
    .select("id,sort_order,revision,chapter_label")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
  if (error) throw new Error(`Could not load section order: ${error.message}`)

  const allRows = (data || []) as Array<{
    id: string
    sort_order: number
    revision: number
    chapter_label: string
  }>
  const current = allRows.find((row) => row.id === id)
  const rows = current
    ? allRows.filter((row) => row.chapter_label === current.chapter_label)
    : []
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
  if (updateError) throw new Error(`Could not move presentation section: ${updateError.message}`)
  if (!updated) throw new Error("This section changed in another session. Refresh before moving it.")
  return listSpcPresentationChunks(true)
}

export async function deleteSpcPresentationChunk(id: string, context: SpcAuditContext) {
  const { data: row, error } = await presentationClient()
    .from(PRESENTATION_TABLE)
    .select("video_path,narration_path")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`Could not load presentation section: ${error.message}`)
  if (!row) throw new Error("Presentation section was not found.")

  const { error: deleteError } = await createSpcAuditedSupabaseClient(context)
    .from(PRESENTATION_TABLE)
    .delete()
    .eq("id", id)
  if (deleteError) throw new Error(`Could not delete presentation section: ${deleteError.message}`)

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
  if (error) throw new Error(`Could not load presentation section: ${error.message}`)
  if (!chunk) throw new Error("Presentation section was not found.")

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
  if (error) throw new Error(`Could not load presentation section: ${error.message}`)
  if (!current) throw new Error("Presentation section was not found.")
  if (Number(current.revision) !== revision) {
    throw new Error("This section changed in another session. Refresh before attaching media.")
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
  if (!updated) throw new Error("This section changed in another session. Refresh before attaching media.")

  const previousPath = kind === "video" ? current.video_path : current.narration_path
  if (previousPath && previousPath !== path) {
    await client.storage.from(PRESENTATION_BUCKET).remove([previousPath])
  }
  return presentSingleRow(updated as unknown as PresentationRow)
}

export function createPresentationContext(session: SpcSession, request: Request) {
  return createSpcAuditContext(session, request, "spc-readme")
}
