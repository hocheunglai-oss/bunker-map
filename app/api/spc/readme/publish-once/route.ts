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

const TOKEN_DIGEST = "47475f101a75e9680a1d8a6f4d8fd04e469e32c3d9d5bb91bf510b30e55fe224"
const EXPIRES_AT = Date.parse("2026-07-23T20:00:00+08:00")
const CHAPTER_TWO_ID = "2856b506-c0ff-4b4c-9410-1eb78e86af5a"
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
  const actual = createHash("sha256").update(request.headers.get("x-spc-publish-token") || "").digest()
  const expected = Buffer.from(TOKEN_DIGEST, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function POST(request: Request) {
  try {
    if (!authorised(request)) return NextResponse.json({ message: "Not found." }, { status: 404 })
    const payload = (await request.json()) as Payload
    if (payload.action === "load") {
      const chunk = (await listSpcPresentationChunks(true)).find((item) => item.id === CHAPTER_TWO_ID)
      return NextResponse.json({ chunks: chunk ? [chunk] : [] })
    }
    if (payload.action === "save" && payload.chunk?.id === CHAPTER_TWO_ID) {
      return NextResponse.json({ chunk: await saveSpcPresentationChunk(payload.chunk, context) })
    }
    if (payload.action === "prepare-upload" && payload.id === CHAPTER_TWO_ID) {
      const upload = await prepareSpcPresentationUpload(
        payload.id,
        "video",
        payload.fileName || "chapter-2-complete-synced.mp4",
        "video/mp4",
        Number(payload.fileBytes || 0),
      )
      return NextResponse.json({ upload })
    }
    if (payload.action === "complete-upload" && payload.id === CHAPTER_TWO_ID) {
      const chunk = await completeSpcPresentationUpload(
        payload.id,
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
