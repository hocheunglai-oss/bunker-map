import assert from "node:assert/strict"
import test from "node:test"
import {
  createRecordStateRoute,
  presentationRow,
  recordStateMemory,
  stateActor,
} from "./fixtures/spc-record-state-api.mjs"

const chunkId = presentationRow.id
const nextVideoPath = `${chunkId}/video-new.mp4`
const nextNarrationPath = `${chunkId}/narration-new.mp3`
const attachment = (overrides = {}) => ({
  action: "complete-upload", id: chunkId, revision: 1, kind: "video",
  path: nextVideoPath, mimeType: "video/mp4", ...overrides,
})
const preparation = (overrides = {}) => ({
  action: "prepare-upload", id: chunkId, kind: "video", fileName: "same.mp4",
  mimeType: "video/mp4", fileBytes: 123, ...overrides,
})
const mediaSnapshot = (db: ReturnType<typeof recordStateMemory>) => [...db.media.entries()]

test("successful logical delete preserves every current and unattached media byte", async () => {
  const db = recordStateMemory()
  db.media.set(nextVideoPath, "N".repeat(123))
  db.media.set("unreferenced-but-retained.mp4", "retained historical bytes")
  const before = mediaSnapshot(db)
  const app = createRecordStateRoute({ kind: "presentation", createClient: db.client })
  const result = await app.mutate({ action: "delete", id: chunkId, revision: 1 })
  assert.equal(result.status, 200)
  assert.equal(db.rows.spc_presentation_chunks.length, 0)
  assert.equal(db.writes.length, 1)
  assert.deepEqual(db.writes[0].filters, [["id", chunkId], ["revision", 1]])
  assert.deepEqual(db.removes, [])
  assert.deepEqual(mediaSnapshot(db), before)
  assert.equal((await app.mutate({ action: "delete", id: chunkId, revision: 1 })).status, 409)
  assert.equal(db.writes.length, 1)
  assert.deepEqual(mediaSnapshot(db), before)
})

test("successful video and narration replacement preserves old, new and unrelated bytes", async () => {
  for (const kind of ["video", "narration"] as const) {
    const db = recordStateMemory()
    const oldNarrationPath = `${chunkId}/narration-original.mp3`
    db.rows.spc_presentation_chunks[0].narration_path = oldNarrationPath
    db.rows.spc_presentation_chunks[0].narration_mime_type = "audio/mpeg"
    db.media.set(oldNarrationPath, "old narration")
    db.media.set(nextVideoPath, "V".repeat(123))
    db.media.set(nextNarrationPath, "A".repeat(123))
    const before = mediaSnapshot(db)
    const app = createRecordStateRoute({ kind: "presentation", createClient: db.client })
    const path = kind === "video" ? nextVideoPath : nextNarrationPath
    const result = await app.mutate(attachment({ kind, path, mimeType: kind === "video" ? "video/mp4" : "audio/mpeg" }))
    assert.equal(result.status, 200)
    assert.equal(result.body.chunk.revision, 2)
    assert.equal(result.body.chunk.mediaVersion, 2)
    assert.equal(kind === "video" ? result.body.chunk.videoPath : result.body.chunk.narrationPath, path)
    assert.equal(db.writes.length, 1)
    assert.deepEqual(db.removes, [])
    assert.deepEqual(mediaSnapshot(db), before)
    assert.ok(db.headers.some(headers => headers["x-bunker-audit-actor-user-id"] === stateActor.userId))
  }
})

test("conflicted or failed replacement never deletes old/current/uploaded bytes", async () => {
  for (const failure of ["revision", "read", "write", "list", "missing-upload", "concurrent"] as const) {
    const db = recordStateMemory({
      readError: failure === "read" ? { message: "Synthetic read failure" } : null,
      writeError: failure === "write" ? { message: "Synthetic write failure" } : null,
      storageListError: failure === "list" ? { message: "Synthetic listing failure" } : null,
      storageListMissing: failure === "missing-upload",
      beforeWrite: async () => {
        if (failure === "concurrent") {
          db.rows.spc_presentation_chunks[0].revision = 2
          db.rows.spc_presentation_chunks[0].video_path = `${chunkId}/video-colleague.mp4`
        }
      },
    })
    db.media.set(nextVideoPath, "N".repeat(123))
    db.media.set(`${chunkId}/video-colleague.mp4`, "colleague media")
    const before = mediaSnapshot(db)
    const app = createRecordStateRoute({ kind: "presentation", createClient: db.client })
    const result = await app.mutate(attachment({ revision: failure === "revision" ? 2 : 1 }))
    assert.equal(result.status, failure === "revision" || failure === "concurrent" ? 409 : failure === "missing-upload" ? 400 : 500)
    assert.equal(db.writes.length, 0)
    assert.deepEqual(db.removes, [])
    assert.deepEqual(mediaSnapshot(db), before)
    assert.equal(db.rows.spc_presentation_chunks[0].video_path, failure === "concurrent" ? `${chunkId}/video-colleague.mp4` : presentationRow.video_path)
  }
})

test("lost acknowledgement retry preserves both generations and performs no second write", async () => {
  const db = recordStateMemory({ loseMediaAck: true })
  db.media.set(nextVideoPath, "N".repeat(123))
  const before = mediaSnapshot(db)
  const app = createRecordStateRoute({ kind: "presentation", createClient: db.client })
  assert.equal((await app.mutate(attachment())).status, 500)
  assert.equal(db.rows.spc_presentation_chunks[0].video_path, nextVideoPath)
  assert.equal(db.writes.length, 1)
  assert.deepEqual(mediaSnapshot(db), before)
  const replay = await app.mutate(attachment())
  assert.equal(replay.status, 200)
  assert.equal(replay.body.chunk.revision, 2)
  assert.equal(db.writes.length, 1)
  assert.deepEqual(db.removes, [])
  assert.deepEqual(mediaSnapshot(db), before)
})

test("same frozen millisecond prepares distinct UUID paths with explicit non-upsert signing", async () => {
  const db = recordStateMemory()
  const app = createRecordStateRoute({ kind: "presentation", createClient: db.client })
  const originalNow = Date.now
  Date.now = () => 1792540800000
  try {
    for (let index = 0; index < 16; index++) {
      const result = await app.mutate(preparation())
      assert.equal(result.status, 200)
      assert.equal(result.body.upload.bucket, "spc-presentation-media")
      assert.equal(result.body.upload.token, "synthetic-upload-token")
      assert.equal(result.body.upload.signedUrl, "https://synthetic.invalid/upload")
    }
  } finally { Date.now = originalNow }
  assert.equal(new Set(db.signs.map(sign => sign.path)).size, 16)
  for (const sign of db.signs) {
    assert.match(sign.path, new RegExp(`^${chunkId}/video-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-same\\.mp4$`))
    assert.deepEqual(sign.options, { upsert: false })
  }
  assert.equal(db.writes.length, 0)
  assert.deepEqual(db.removes, [])
})

test("narration preparation retains the existing response and signs without overwrite", async () => {
  const db = recordStateMemory()
  const app = createRecordStateRoute({ kind: "presentation", createClient: db.client })
  const result = await app.mutate(preparation({ kind: "narration", fileName: "Voice Note.mp3", mimeType: "audio/mpeg" }))
  assert.equal(result.status, 200)
  assert.match(result.body.upload.path, new RegExp(`^${chunkId}/narration-[a-f0-9-]+-voice-note\\.mp3$`))
  assert.deepEqual(db.signs[0].options, { upsert: false })
  assert.equal(db.writes.length, 0)
  assert.deepEqual(db.removes, [])
})

test("legacy timestamp-based attachment paths remain accepted without deleting earlier media", async () => {
  const db = recordStateMemory()
  const legacyPath = `${chunkId}/video-1700000000000-legacy.mp4`
  db.media.set(legacyPath, "L".repeat(123))
  const before = mediaSnapshot(db)
  const app = createRecordStateRoute({ kind: "presentation", createClient: db.client })
  const result = await app.mutate(attachment({ path: legacyPath }))
  assert.equal(result.status, 200)
  assert.equal(result.body.chunk.videoPath, legacyPath)
  assert.deepEqual(db.removes, [])
  assert.deepEqual(mediaSnapshot(db), before)
})

test("signed-out, View-only and denied users cannot mutate, sign or remove media", async () => {
  for (const [actor, permission, expectedStatus] of [[null, "edit", 401], [stateActor, "view", 403], [stateActor, "none", 403]] as const) {
    for (const payload of [preparation(), attachment(), { action: "delete", id: chunkId, revision: 1 }]) {
      const db = recordStateMemory()
      const beforeRows = structuredClone(db.rows)
      const beforeMedia = mediaSnapshot(db)
      const app = createRecordStateRoute({ kind: "presentation", createClient: db.client, actor, permission })
      assert.equal((await app.mutate(payload)).status, expectedStatus)
      assert.equal(db.headers.length, 0)
      assert.equal(db.writes.length, 0)
      assert.deepEqual(db.signs, [])
      assert.deepEqual(db.removes, [])
      assert.deepEqual(db.rows, beforeRows)
      assert.deepEqual(mediaSnapshot(db), beforeMedia)
    }
  }
})

test("failed upload signing performs no database mutation or physical removal", async () => {
  const db = recordStateMemory({ signError: { message: "Synthetic signing failure" } })
  const beforeRows = structuredClone(db.rows)
  const beforeMedia = mediaSnapshot(db)
  const app = createRecordStateRoute({ kind: "presentation", createClient: db.client })
  assert.equal((await app.mutate(preparation())).status, 500)
  assert.equal(db.writes.length, 0)
  assert.deepEqual(db.removes, [])
  assert.deepEqual(db.rows, beforeRows)
  assert.deepEqual(mediaSnapshot(db), beforeMedia)
})
