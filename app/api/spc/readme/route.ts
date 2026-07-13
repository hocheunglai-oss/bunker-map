import { NextResponse } from "next/server"
import {
  hasSpcPagePermission,
  requireSpcPagePermission,
} from "@/lib/spcAuth"
import {
  completeSpcPresentationUpload,
  createPresentationContext,
  deleteSpcPresentationChunk,
  listSpcPresentationChunks,
  moveSpcPresentationChunk,
  prepareSpcPresentationUpload,
  saveSpcPresentationChunk,
  type PresentationUploadKind,
  type SaveSpcPresentationChunkInput,
} from "@/lib/spcPresentation"
import { timedJson } from "@/lib/serverTiming"

export const dynamic = "force-dynamic"
export const maxDuration = 30

type PresentationActionPayload = {
  action?: string
  id?: string
  revision?: number
  direction?: "earlier" | "later"
  kind?: PresentationUploadKind
  fileName?: string
  mimeType?: string
  fileBytes?: number
  path?: string
  chunk?: SaveSpcPresentationChunkInput
}

function errorResponse(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  const status =
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : message.includes("another session")
          ? 409
          : message.includes("required") ||
              message.includes("Invalid") ||
              message.includes("valid") ||
              message.includes("smaller than") ||
              message.includes("not found") ||
              message.includes("could not be verified")
            ? 400
            : 500
  return NextResponse.json({ message }, { status })
}

export async function GET() {
  const startedAt = Date.now()
  try {
    const session = await requireSpcPagePermission("spc-readme", "view")
    const canEdit = hasSpcPagePermission(session, "spc-readme", "edit")
    const chunks = await listSpcPresentationChunks(canEdit)
    return timedJson(
      "/api/spc/readme",
      startedAt,
      { chunks, canEdit },
      { headers: { "Cache-Control": "private, no-store" } },
      { chunks: chunks.length, canEdit },
    )
  } catch (error) {
    return errorResponse(error, "Could not load README content.")
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-readme", "edit")
    const payload = (await request.json()) as PresentationActionPayload
    const context = createPresentationContext(session, request)

    if (payload.action === "save") {
      if (!payload.chunk) throw new Error("Chunk details are required.")
      const chunk = await saveSpcPresentationChunk(payload.chunk, context)
      return NextResponse.json({ success: true, chunk })
    }

    if (payload.action === "move") {
      if (!payload.id) throw new Error("Chunk id is required.")
      if (payload.direction !== "earlier" && payload.direction !== "later") {
        throw new Error("Invalid move direction.")
      }
      const chunks = await moveSpcPresentationChunk(payload.id, payload.direction, context)
      return NextResponse.json({ success: true, chunks })
    }

    if (payload.action === "delete") {
      if (!payload.id) throw new Error("Chunk id is required.")
      await deleteSpcPresentationChunk(payload.id, context)
      return NextResponse.json({ success: true })
    }

    if (payload.action === "prepare-upload") {
      if (!payload.id) throw new Error("Chunk id is required.")
      if (payload.kind !== "video" && payload.kind !== "narration") {
        throw new Error("Invalid media type.")
      }
      const upload = await prepareSpcPresentationUpload(
        payload.id,
        payload.kind,
        payload.fileName || "media",
        payload.mimeType || "application/octet-stream",
        Number(payload.fileBytes || 0),
      )
      return NextResponse.json({ success: true, upload })
    }

    if (payload.action === "complete-upload") {
      if (!payload.id || !payload.path) throw new Error("Uploaded media details are required.")
      if (payload.kind !== "video" && payload.kind !== "narration") {
        throw new Error("Invalid media type.")
      }
      const chunk = await completeSpcPresentationUpload(
        payload.id,
        Math.max(Number(payload.revision || 0), 1),
        payload.kind,
        payload.path,
        payload.mimeType || "application/octet-stream",
        context,
      )
      return NextResponse.json({ success: true, chunk })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    return errorResponse(error, "Could not update README content.")
  }
}
