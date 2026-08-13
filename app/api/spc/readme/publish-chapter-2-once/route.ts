import { createHash, timingSafeEqual } from "node:crypto"

import { NextResponse } from "next/server"
import { createSpcAuditContext } from "@/lib/spcAudit"
import type { SpcSession } from "@/lib/spcAuth"
import {
  completeSpcPresentationUpload,
  listSpcPresentationChunks,
  prepareSpcPresentationUpload,
  saveSpcPresentationChunk,
  type SaveSpcPresentationChunkInput,
} from "@/lib/spcPresentation"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TOKEN_DIGEST = "85f69d33b80d54befd3967bdedac4ad77cfe059629d2cf2810cd39be025af026"
const EXPIRES_AT = Date.parse("2026-08-13T06:51:42Z")
const CHAPTER_TWO_ID = "2856b506-c0ff-4b4c-9410-1eb78e86af5a"
const publisherSession: SpcSession = {
  authenticated: true,
  userId: "f345a8d9-384d-4134-b89d-f909505b4b36",
  username: "otto@cosulich.com.hk",
  displayName: "Codex",
  role: "buyer_trader",
  office: "HK",
  mustChangePassword: false,
  mfaVerifiedAt: null,
  permissions: {},
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
  return id === CHAPTER_TWO_ID
}

export async function POST(request: Request) {
  try {
    if (!authorised(request)) {
      return NextResponse.json({ message: "Not found." }, { status: 404 })
    }
    const payload = (await request.json()) as Payload
    const context = createSpcAuditContext(publisherSession, request, "spc-readme")

    if (payload.action === "load") {
      const chunk = (await listSpcPresentationChunks(true)).find(
        (item) => item.id === CHAPTER_TWO_ID,
      )
      return NextResponse.json({ chunks: chunk ? [chunk] : [] })
    }
    if (payload.action === "save") {
      if (!allowed(payload.chunk?.id)) throw new Error("Invalid chapter.")
      return NextResponse.json({ chunk: await saveSpcPresentationChunk(payload.chunk!, context) })
    }
    if (payload.action === "prepare-upload") {
      if (!allowed(payload.id)) throw new Error("Invalid chapter.")
      const upload = await prepareSpcPresentationUpload(
        payload.id!,
        "video",
        payload.fileName || "chapter-2-complete-synced.mp4",
        "video/mp4",
        Number(payload.fileBytes || 0),
      )
      return NextResponse.json({ upload })
    }
    if (payload.action === "complete-upload") {
      if (!allowed(payload.id)) throw new Error("Invalid chapter.")
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
    return NextResponse.json(
      { message },
      { status: message.includes("another session") ? 409 : 400 },
    )
  }
}
