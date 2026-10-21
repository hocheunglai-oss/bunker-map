import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { createRetainedDriveReadAdapter } from "../scripts/lib/storage-media-retained-drive.mjs"

const account = fcunoConnectionPolicy.storageMediaBackup.googleAccount
const digest = value => createHash("sha256").update(value).digest("hex")
const parentId = "configured-parent"
function context(controller = new AbortController(), duration = 60_000) {
  return { signal: controller.signal, deadline: Date.now() + duration }
}
function file(fileId, day, bytes = Uint8Array.from([1, 2, 3, 4]), additionalProperties = {}) {
  return { id: fileId, name: `bunker-map-backup-2026-10-${day}T01-00-00-000Z.json`, createdTime: `2026-10-${day}T01:00:00.000Z`,
    mimeType: "application/json", trashed: false, parents: ["daily-folder"], version: "9007199254740993123", size: String(bytes.byteLength),
    appProperties: { backupSchema: "bunker-map-backup/v2", verificationStatus: "complete", artifactSha256: "a".repeat(64),
      uploadedFileSha256: digest(bytes), fileByteLength: String(bytes.byteLength), truthHeadSequence: "10", truthHeadSha256: "b".repeat(64),
      ...additionalProperties } }
}
function completeProperties() {
  return { verificationContract: "bunker-map-backup-stream-verification/v1", migrationHead: "20261014044009", databaseEpoch: "0",
    inventorySha256: "c".repeat(64), catalogSha256: "d".repeat(64), liveTableCount: "10", sectionCount: "12", totalRecordCount: "0",
    backupRunId: "offline-run", generatedAt: "2026-10-21T01:00:00.000Z", deploymentCommit: "none", source: "vercel-cron",
    latestCertificationRunId: "certified-offline", latestProjectionSnapshotSha256: "e".repeat(64), previousFileId: "previous-file",
    previousFileName: "none", previousCreatedTime: "none", previousArtifactSha256: "none", previousUploadedFileSha256: "none" }
}
function setup(options = {}) {
  const defaultBytes = Uint8Array.from([1, 2, 3, 4])
  const fixture = {
    files: options.files ?? [file("previous", "20"), file("latest", "21")],
    rootFolders: [{ id: "backup-folder", name: "Bunker Map Backups", mimeType: "application/vnd.google-apps.folder",
      trashed: false, parents: [parentId], version: "12" }],
    dailyFolders: [{ id: "daily-folder", name: "Daily Supabase Backups", mimeType: "application/vnd.google-apps.folder",
      trashed: false, parents: ["backup-folder"], version: "14" }],
    metadata: new Map(), calls: [], tokens: [], cancelled: 0, mediaReads: 0,
  }
  for (const item of fixture.files) fixture.metadata.set(item.id, structuredClone(item))
  const adapter = createRetainedDriveReadAdapter({ parentFolderId: parentId, sharedDriveId: options.sharedDriveId ?? null,
    getAccessToken: options.getAccessToken ?? (async ctx => { ctx.signal.throwIfAborted(); fixture.tokens.push(ctx); return `existing-oauth-${fixture.tokens.length}` }),
    fetch: async (input, init) => {
      const url = new URL(input)
      fixture.calls.push({ url, init })
      assert.equal(url.origin, "https://www.googleapis.com")
      assert.ok(url.pathname.startsWith("/drive/v3/"))
      assert.equal(init.method, "GET")
      assert.equal(init.redirect, "error")
      assert.equal(init.cache, "no-store")
      assert.equal(init.headers["Accept-Encoding"], "identity")
      assert.equal(init.headers.Cookie, undefined)
      assert.equal(init.body, undefined)
      assert.equal(init.signal.aborted, false)
      const override = await options.respond?.(url, init, fixture)
      if (override !== undefined) return override
      if (url.pathname === "/drive/v3/about") {
        assert.equal(url.searchParams.get("fields"), "user(emailAddress)")
        return Response.json({ user: { emailAddress: options.account ?? account } })
      }
      if (url.pathname === "/drive/v3/files") {
        assert.equal(url.searchParams.get("supportsAllDrives"), "true")
        assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true")
        assert.equal(url.searchParams.get("pageSize"), "100")
        assert.equal(url.searchParams.get("orderBy"), "createdTime desc")
        assert.ok(url.searchParams.get("fields").includes("incompleteSearch"))
        const query = url.searchParams.get("q")
        if (query.includes("name = 'Bunker Map Backups'")) return Response.json({ files: fixture.rootFolders })
        if (query.includes("name = 'Daily Supabase Backups'")) return Response.json({ files: fixture.dailyFolders })
        return Response.json({ files: fixture.files })
      }
      const fileId = url.pathname.split("/").at(-1)
      if (url.searchParams.get("alt") === "media") {
        fixture.mediaReads++
        const bytes = options.bytes ?? defaultBytes
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() },
          cancel() { fixture.cancelled++ } }), { headers: { "Content-Type": "application/json", ...options.mediaHeaders } })
      }
      assert.equal(url.searchParams.get("supportsAllDrives"), "true")
      assert.ok(url.searchParams.get("fields").includes("version,size,appProperties"))
      return Response.json(fixture.metadata.get(fileId))
    },
  })
  return { adapter, fixture }
}
async function consume(opened) {
  const pieces = []
  for await (const value of opened.bytes) pieces.push(value)
  return Buffer.concat(pieces)
}
async function prepare(options) {
  const result = setup(options)
  result.catalog = await result.adapter.readRetainedPair(context())
  return result
}

test("exact existing folder hierarchy, route sort and independent receipts are retained without checkpoint invention", async () => {
  const candidates = [file("older", "19"), file("previous", "20"), file("latest", "21", undefined, completeProperties()),
    { ...file("invalid-name", "22"), name: "bunker-map-backup-scratch.json" },
    file("unverified", "23", undefined, { verificationStatus: "uploading" }),
    { ...file("wrong-mime", "24"), mimeType: "text/plain" }]
  const { adapter, fixture, catalog } = await prepare({ files: candidates })
  assert.deepEqual(catalog.files.map(item => item.fileId), ["latest", "previous"])
  assert.equal(catalog.parentFolderId, parentId)
  assert.equal(catalog.backupFolder.folderId, "backup-folder")
  assert.equal(catalog.dailyFolder.folderId, "daily-folder")
  const selected = catalog.files[0]
  assert.equal(selected.version, "9007199254740993123")
  assert.equal(selected.size, "4")
  assert.equal(selected.sizeBytes, 4)
  assert.equal(selected.uploadedFileSha256, candidates[2].appProperties.uploadedFileSha256)
  assert.equal(selected.artifactSha256, candidates[2].appProperties.artifactSha256)
  assert.equal(selected.fileByteLength, 4)
  assert.equal(Object.hasOwn(selected, "checkpoint"), false)
  assert.ok(Object.isFrozen(catalog) && Object.isFrozen(catalog.files) && Object.isFrozen(selected) && Object.isFrozen(selected.appProperties))
  assert.deepEqual(await consume(await adapter.openRetainedArtifact(selected, context())), Buffer.from([1, 2, 3, 4]))
  assert.equal(fixture.mediaReads, 1)
  assert.equal(await adapter.verifyRetainedPair(catalog, context()), catalog)
  assert.equal(fixture.tokens.length, 3)
  for (let index = 0, token = 0; index < fixture.calls.length; index++) {
    if (fixture.calls[index].url.pathname.endsWith("/about")) token++
    assert.equal(fixture.calls[index].init.headers.Authorization, `Bearer existing-oauth-${token}`)
  }
  const listQueries = fixture.calls.filter(call => call.url.pathname === "/drive/v3/files").map(call => call.url.searchParams.get("q"))
  assert.ok(listQueries[0].includes(`'${parentId}' in parents and name = 'Bunker Map Backups'`))
  assert.ok(listQueries[1].includes("'backup-folder' in parents and name = 'Daily Supabase Backups'"))
  assert.ok(listQueries[2].includes("'daily-folder' in parents and name contains 'bunker-map-backup-'"))
})

test("account mismatch fails before folder/file reads, without falling back to a service account", async () => {
  const { adapter, fixture } = setup({ account: "different@example.invalid" })
  await assert.rejects(adapter.readRetainedPair(context()), error => error.code === "DRIVE_ACCOUNT_MISMATCH")
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0].url.pathname, "/drive/v3/about")
})

test("folder lookup never creates missing folders and fails ambiguous exact matches across pages", async () => {
  for (const depth of ["rootFolders", "dailyFolders"]) {
    const { adapter, fixture } = setup()
    fixture[depth] = []
    await assert.rejects(adapter.readRetainedPair(context()), error => error.code === "DRIVE_FOLDER_MISSING")
    assert.equal(fixture.mediaReads, 0)
  }
  const { adapter, fixture } = setup({ respond: (url, _init, state) => {
    if (url.pathname === "/drive/v3/files" && url.searchParams.get("q").includes("name = 'Bunker Map Backups'")) {
      if (!url.searchParams.has("pageToken")) return Response.json({ files: state.rootFolders, nextPageToken: "second" })
      return Response.json({ files: [{ ...state.rootFolders[0], id: "other-matching-folder" }] })
    }
  } })
  await assert.rejects(adapter.readRetainedPair(context()), error => error.code === "DRIVE_FOLDER_AMBIGUOUS")
  assert.equal(fixture.mediaReads, 0)
  assert.ok(fixture.calls.every(call => call.init.method === "GET"))
})

test("folder placement, trash state and MIME are checked rather than trusting names", async () => {
  for (const change of [{ parents: ["other-parent"] }, { trashed: true }, { mimeType: "application/vnd.google-apps.shortcut" }, { name: "Similar Bunker Map Backups" }]) {
    const { adapter, fixture } = setup()
    Object.assign(fixture.rootFolders[0], change)
    await assert.rejects(adapter.readRetainedPair(context()))
    assert.equal(fixture.mediaReads, 0)
  }
})

test("bounded pagination follows empty pages and route name/id tie-breakers before selecting exactly two", async () => {
  const a = file("a", "21"), z = file("z", "21"), older = file("older", "20")
  const { adapter, fixture } = setup({ files: [a, z, older], sharedDriveId: "existing-shared-drive", respond: url => {
    if (url.pathname !== "/drive/v3/files" || !url.searchParams.get("q").includes("name contains")) return
    const page = url.searchParams.get("pageToken")
    if (page === null) return Response.json({ files: [older, a], nextPageToken: "empty" })
    if (page === "empty") return Response.json({ files: [], nextPageToken: "last" })
    assert.equal(page, "last")
    return Response.json({ files: [z] })
  } })
  const catalog = await adapter.readRetainedPair(context())
  assert.deepEqual(catalog.files.map(value => value.fileId), ["z", "a"])
  for (const call of fixture.calls.filter(value => value.url.pathname === "/drive/v3/files")) {
    assert.equal(call.url.searchParams.get("corpora"), "drive")
    assert.equal(call.url.searchParams.get("driveId"), "existing-shared-drive")
  }
})

test("duplicate pages, incomplete search, oversized pages and invalid continuation tokens fail closed", async () => {
  for (const kind of ["duplicate", "loop", "incomplete", "oversized", "invalid-token"]) {
    const { adapter, fixture } = setup({ respond: url => {
      if (url.pathname !== "/drive/v3/files" || !url.searchParams.get("q").includes("name contains")) return
      if (kind === "duplicate") return Response.json({ files: [file("same", "21")], nextPageToken: "again" })
      if (kind === "loop") return Response.json({ files: [], nextPageToken: "again" })
      if (kind === "incomplete") return Response.json({ files: [], incompleteSearch: true })
      if (kind === "oversized") return Response.json({ files: Array.from({ length: 101 }, (_, index) => file(`file-${index}`, "21")) })
      return Response.json({ files: [], nextPageToken: null })
    } })
    await assert.rejects(adapter.readRetainedPair(context()))
    assert.equal(fixture.mediaReads, 0)
  }
})

test("endless unique empty list pages are capped without media reads", async () => {
  let pages = 0
  const { adapter, fixture } = setup({ respond: url => {
    if (url.pathname === "/drive/v3/files" && url.searchParams.get("q").includes("name contains")) {
      return Response.json({ files: [], nextPageToken: `page-${++pages}` })
    }
  } })
  await assert.rejects(adapter.readRetainedPair(context()))
  assert.equal(pages, 500)
  assert.equal(fixture.mediaReads, 0)
})

test("receipt schema validation mirrors legacy and full stream-contract backups", async () => {
  for (const change of [{ verificationContract: "unsupported/v2" }, { verificationContract: "bunker-map-backup-stream-verification/v1" },
    { fileByteLength: "5" }, { truthHeadSequence: "0" }, { truthHeadSha256: "invalid" },
    { ...completeProperties(), inventorySha256: "invalid" }, { ...completeProperties(), sectionCount: "0" },
    { ...completeProperties(), migrationHead: "not-a-migration" }, { ...completeProperties(), totalRecordCount: "-1" }]) {
    const { adapter, fixture } = setup({ files: [file("latest", "21", undefined, change), file("previous", "20")] })
    await assert.rejects(adapter.readRetainedPair(context()))
    assert.equal(fixture.mediaReads, 0)
  }
  const { catalog } = await prepare()
  assert.equal(catalog.files[0].appProperties.verificationContract, undefined)
})

test("fewer than two verified candidates cannot manufacture a retained pair", async () => {
  for (const candidates of [[], [file("only-one", "21")], [file("verified", "21"), file("unverified", "20", undefined, { uploadedFileSha256: "invalid" })]]) {
    const { adapter, fixture } = setup({ files: candidates })
    await assert.rejects(adapter.readRetainedPair(context()), error => error.code === "DRIVE_RETAINED_PAIR_MISSING")
    assert.equal(fixture.mediaReads, 0)
  }
})

test("list metadata is directly fenced before a catalog is returned", async () => {
  const { adapter, fixture } = setup()
  fixture.metadata.get("latest").version = "9007199254740993124"
  await assert.rejects(adapter.readRetainedPair(context()), error => error.code === "DRIVE_FILE_CHANGED")
  assert.equal(fixture.mediaReads, 0)
})

test("only issued immutable descriptors can be opened or rechecked", async () => {
  const { adapter, fixture, catalog } = await prepare()
  const previousCalls = fixture.calls.length
  await assert.rejects(adapter.openRetainedArtifact({ ...catalog.files[0] }, context()))
  await assert.rejects(adapter.verifyRetainedPair({ ...catalog }, context()))
  assert.equal(fixture.calls.length, previousCalls)
})

test("version, size, trash, parent, MIME and independent receipt changes fail the pre-read fence", async () => {
  for (const change of [{ version: "2" }, { size: "5" }, { trashed: true }, { parents: ["other-folder"] }, { mimeType: "text/plain" },
    { appProperties: { ...file("fixture", "21").appProperties, uploadedFileSha256: "f".repeat(64) } }]) {
    const { adapter, fixture, catalog } = await prepare()
    Object.assign(fixture.metadata.get("latest"), change)
    await assert.rejects(adapter.openRetainedArtifact(catalog.files[0], context()))
    assert.equal(fixture.mediaReads, 0)
  }
})

test("post-read immutable fences run after receipt validation and before successful stream EOF", async () => {
  for (const change of [{ version: "2" }, { size: "5" }, { trashed: true }, { parents: ["other-folder"] }, { mimeType: "text/plain" },
    { appProperties: { ...file("fixture", "21").appProperties, artifactSha256: "f".repeat(64) } }]) {
    const { adapter, fixture, catalog } = await prepare({ respond: (url, _init, state) => {
      if (url.searchParams.get("alt") === "media") Object.assign(state.metadata.get("latest"), change)
    } })
    const opened = await adapter.openRetainedArtifact(catalog.files[0], context())
    await assert.rejects(consume(opened))
    assert.equal(fixture.mediaReads, 1)
  }
})

test("raw SHA-256/length are anchored to appProperties, not a self-computed download receipt", async () => {
  for (const bytes of [Uint8Array.from([9, 9, 9, 9]), Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3, 4, 5])]) {
    const { adapter, catalog } = await prepare({ bytes })
    await assert.rejects(consume(await adapter.openRetainedArtifact(catalog.files[0], context())))
  }
})

test("artifact bytes are rechunked to at most 64 KiB without collecting the complete body", async () => {
  const bytes = new Uint8Array(512 * 1024 + 17).fill(7)
  const { adapter, fixture, catalog } = await prepare({ files: [file("latest", "21", bytes), file("previous", "20", bytes)], bytes })
  const opened = await adapter.openRetainedArtifact(catalog.files[0], context())
  let length = 0, chunks = 0
  for await (const chunk of opened.bytes) {
    assert.ok(chunk.byteLength <= 64 * 1024)
    length += chunk.byteLength; chunks++
  }
  assert.equal(length, bytes.byteLength)
  assert.equal(chunks, 9)
  assert.equal(fixture.mediaReads, 1)
})

test("partial, redirected, compressed, ranged and mis-sized media responses never certify", async () => {
  for (const change of [{ status: 206 }, { status: 302 }, { status: 412 }, { headers: { "Content-Encoding": "gzip" } },
    { headers: { "Content-Range": "bytes 0-3/4" } }, { headers: { "Content-Length": "5" } }, { headers: { "Content-Type": "text/html" } }]) {
    const { adapter, catalog } = await prepare({ respond: url => {
      if (url.searchParams.get("alt") === "media") return new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: change.status ?? 200, headers: { "Content-Type": "application/json", ...change.headers } })
    } })
    await assert.rejects(consume(await adapter.openRetainedArtifact(catalog.files[0], context())))
  }
})

test("retained rotation or receipt/folder metadata changes fail the final catalog check", async () => {
  for (const change of ["rotation", "receipt", "version", "folder"]) {
    const { adapter, fixture, catalog } = await prepare()
    if (change === "rotation") {
      const newest = file("newest", "22")
      fixture.files.push(newest); fixture.metadata.set(newest.id, newest)
    } else if (change === "receipt") {
      fixture.files.find(item => item.id === "latest").appProperties.artifactSha256 = "f".repeat(64)
      fixture.metadata.get("latest").appProperties.artifactSha256 = "f".repeat(64)
    } else if (change === "version") {
      fixture.files.find(item => item.id === "latest").version = "2"
      fixture.metadata.get("latest").version = "2"
    } else fixture.dailyFolders[0].version = "15"
    await assert.rejects(adapter.verifyRetainedPair(catalog, context()), error => error.code === "DRIVE_RETAINED_PAIR_CHANGED")
  }
})

test("cancellation closes an in-flight stalled body and never executes the post-read fence", async () => {
  let cancelled = false
  const { adapter, fixture, catalog } = await prepare({ respond: url => {
    if (url.searchParams.get("alt") === "media") return new Response(new ReadableStream({
      pull() { return new Promise(() => {}) }, cancel() { cancelled = true },
    }), { headers: { "Content-Type": "application/json" } })
  } })
  const controller = new AbortController()
  const opened = await adapter.openRetainedArtifact(catalog.files[0], context(controller))
  const pending = opened.bytes.next()
  const timeout = setTimeout(() => controller.abort(new Error("offline cancellation")), 10)
  try { await assert.rejects(pending, /offline cancellation/) } finally { clearTimeout(timeout) }
  assert.equal(cancelled, true)
  const mediaCall = fixture.calls.findIndex(call => call.url.searchParams.get("alt") === "media")
  assert.equal(fixture.calls.length, mediaCall + 1)
})

test("deadline expires while awaiting a stalled token provider, with no provider requests", async () => {
  const { adapter, fixture } = setup({ getAccessToken: () => new Promise(() => {}) })
  const keepAlive = setTimeout(() => {}, 1000)
  try { await assert.rejects(adapter.readRetainedPair(context(new AbortController(), 20)), error => error.name === "TimeoutError") }
  finally { clearTimeout(keepAlive) }
  assert.equal(fixture.calls.length, 0)
})

test("already aborted or expired contexts fail without OAuth or provider access", async () => {
  const { adapter, fixture } = setup(), controller = new AbortController()
  controller.abort()
  await assert.rejects(adapter.readRetainedPair(context(controller)))
  await assert.rejects(adapter.readRetainedPair(context(new AbortController(), -1)))
  assert.equal(fixture.tokens.length, 0)
  assert.equal(fixture.calls.length, 0)
})

test("early stream closure cancels the body; closing an unstarted iterator opens no media response", async () => {
  let cancelled = 0
  const { adapter, fixture, catalog } = await prepare({ respond: url => {
    if (url.searchParams.get("alt") === "media") return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.from([1, 2, 3, 4])) }, cancel() { cancelled++ },
    }), { headers: { "Content-Type": "application/json" } })
  } })
  const unstarted = await adapter.openRetainedArtifact(catalog.files[0], context())
  await unstarted.bytes.return()
  assert.equal(fixture.calls.filter(call => call.url.searchParams.get("alt") === "media").length, 0)
  const opened = await adapter.openRetainedArtifact(catalog.files[0], context())
  assert.equal((await opened.bytes.next()).done, false)
  await opened.bytes.return()
  assert.equal(cancelled, 1)
})

test("metadata JSON has a fixed byte budget and no HTML/auth redirect fallback", async () => {
  for (const response of [new Response("x".repeat(2 * 1024 * 1024 + 1)), new Response("<html>sign in</html>"), new Response(null, { status: 302 })]) {
    const { adapter, fixture } = setup({ respond: url => url.pathname === "/drive/v3/about" ? response : undefined })
    await assert.rejects(adapter.readRetainedPair(context()))
    assert.equal(fixture.calls.length, 1)
  }
})

test("configuration is explicitly injected and cannot redirect fixed-origin GETs via folder IDs", () => {
  for (const invalid of [undefined, "", "../files", "root' or trashed = true", "https://elsewhere.invalid", "folder\\name"]) {
    assert.throws(() => createRetainedDriveReadAdapter({ getAccessToken: async () => "unused", parentFolderId: invalid }))
  }
  assert.throws(() => createRetainedDriveReadAdapter({ parentFolderId: parentId }))
})
