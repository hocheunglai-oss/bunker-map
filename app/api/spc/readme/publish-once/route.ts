import { createHash, timingSafeEqual } from "node:crypto"

import { NextResponse } from "next/server"
import type { SpcAuditContext } from "@/lib/spcAudit"
import {
  completeSpcPresentationUpload,
  listSpcPresentationChunks,
  prepareSpcPresentationUpload,
  saveSpcPresentationChunk,
  type SaveSpcPresentationChunkInput,
} from "@/lib/spcPresentation"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TOKEN_DIGEST = "0f65b6fe1ce104a92a43098249f387f3669b9a346024a6200b8ca98560bd6edf"
const EXPIRES_AT = Date.parse("2026-07-22T16:00:00+08:00")
const ALLOWED_IDS = new Set([
  "2856b506-c0ff-4b4c-9410-1eb78e86af5a",
  "d469706a-743c-48e5-8644-093280a5fc65",
  "76d25e3e-5228-4671-af89-62de130eb34a",
  "cfbdd69f-e8a2-469e-993a-c5aac540e2ee",
  "3e0f18fd-8a85-4a65-acd4-280c01dd5b52",
  "b2e4061c-e77a-424b-950f-e9d2bb20447f",
])
const context: SpcAuditContext = {
  username: "Codex",
  displayName: "Codex",
  role: "SYSTEM",
  pageId: "spc-readme",
  pageLabel: "SPC README",
  pagePath: "/spc/readme",
}

type Payload = {
  action?: "load" | "save" | "prepare-upload" | "complete-upload"
  id?: string
  revision?: number
  fileName?: string
  fileBytes?: number
  path?: string
  chunk?: SaveSpcPresentationChunkInput
}

function authorised(request: Request) {
  if (Date.now() > EXPIRES_AT) return false
  const supplied = request.headers.get("x-spc-publish-token") || ""
  const actual = createHash("sha256").update(supplied).digest()
  const expected = Buffer.from(TOKEN_DIGEST, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function allowed(id: string | undefined) {
  return Boolean(id && ALLOWED_IDS.has(id))
}

export async function POST(request: Request) {
  try {
    if (!authorised(request)) return NextResponse.json({ message: "Not found." }, { status: 404 })
    const payload = (await request.json()) as Payload

    if (payload.action === "load") {
      const chunks = (await listSpcPresentationChunks(true)).filter((chunk) => ALLOWED_IDS.has(chunk.id))
      return NextResponse.json({ chunks })
    }

    if (payload.action === "save") {
      if (!allowed(payload.chunk?.id)) throw new Error("Invalid section.")
      return NextResponse.json({ chunk: await saveSpcPresentationChunk(payload.chunk!, context) })
    }

    if (payload.action === "prepare-upload") {
      if (!allowed(payload.id)) throw new Error("Invalid section.")
      const upload = await prepareSpcPresentationUpload(
        payload.id!,
        "video",
        payload.fileName || "presentation-synced.mp4",
        "video/mp4",
        Number(payload.fileBytes || 0),
      )
      return NextResponse.json({ upload })
    }

    if (payload.action === "complete-upload") {
      if (!allowed(payload.id)) throw new Error("Invalid section.")
      const chunk = await completeSpcPresentationUpload(
        payload.id!,
        Math.max(Number(payload.revision || 0), 1),
        "video",
        payload.path || "",
        "video/mp4",
        context,
      )
      return NextResponse.json({ chunk })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish failed."
    return NextResponse.json({ message }, { status: message.includes("another session") ? 409 : 400 })
  }
}
