import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import { fcunoConnectionPolicy } from "../config/fcunoConnections"
import { parseAttendanceBackupSchemaVersion } from "../lib/backupAttendanceSchema.mjs"
import { parsePricingBackupSchemaVersion } from "../lib/backupPricingSchema.mjs"

const day = "2026-10-27T19:14:54.575Z", sha = "a".repeat(64), daily = fcunoConnectionPolicy.dailyBackupReceipt.dailyFolderId
function backup() {
  return { id: "synthetic-backup", name: "bunker-map-backup-2026-10-27T19-03-49-623Z.json", mimeType: "application/json", trashed: false,
    parents: [daily], createdTime: day, modifiedTime: "2026-10-27T19:14:55.570Z", size: "2883558296", version: "3", headRevisionId: "synthetic-revision",
    md5Checksum: "b".repeat(32), sha256Checksum: sha,
    appProperties: { backupSchema: "bunker-map-backup/v2", verificationContract: "bunker-map-backup-stream-verification/v1", verificationStatus: "complete",
      artifactSha256: "c".repeat(64), uploadedFileSha256: sha, fileByteLength: "2883558296", truthHeadSequence: "100", truthHeadSha256: "d".repeat(64),
      migrationHead: "20261027035525", databaseEpoch: "10", inventorySha256: "e".repeat(64), catalogSha256: "f".repeat(64), liveTableCount: "67",
      sectionCount: "70", totalRecordCount: "10000", backupRunId: "a1813c7e-a2b9-47d4-9d49-9d99f84dca4e", generatedAt: "2026-10-27T19:03:49.623Z",
      deploymentCommit: "1c25f6525cebbff670a27afeb90d9fd1fc6dc342", source: "vercel-cron", latestCertificationRunId: "d1c4339e-c89d-45e5-b46d-07b35a5b50b2",
      latestProjectionSnapshotSha256: "a".repeat(64), previousFileId: "synthetic-predecessor", previousFileName: "bunker-map-backup-2026-10-26T19-03-22-741Z.json",
      previousCreatedTime: "2026-10-26T19:12:27.587Z", previousArtifactSha256: "b".repeat(64), previousUploadedFileSha256: "c".repeat(64),
      pricingSchemaVersion: "recovery-v2", attendanceSchemaVersion: "annual-v1" } }
}
type AnyRecord = Record<string, any>
function fixture(input: { authError?: string; role?: string; email?: string; env?: AnyRecord; mutate?: (file: AnyRecord) => void;
  folder?: (file: AnyRecord, index: number) => void; listing?: (result: AnyRecord, call: number) => void; get?: (file: AnyRecord) => void;
  failAt?: string; after?: (file: AnyRecord) => void } = {}) {
  const calls: AnyRecord[] = [], env = {
    VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: fcunoConnectionPolicy.vercel.projectId,
    NEXT_PUBLIC_SUPABASE_URL: `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co`, GOOGLE_DRIVE_BACKUP_FOLDER_ID: "synthetic-root",
    GOOGLE_OAUTH_CLIENT_ID: "synthetic-client", GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-secret", GOOGLE_DRIVE_REFRESH_TOKEN: "synthetic-refresh", ...input.env,
  }
  const file = backup(); input.mutate?.(file)
  let lists = 0
  const copy = (value: unknown) => structuredClone(value)
  const request = (name: string, params: AnyRecord, options: AnyRecord) => {
    assert.equal(params.alt, undefined, "metadata-only: alt=media is forbidden")
    assert.equal(options.responseType, undefined, "no streaming/download options")
    assert.equal(options.headers, undefined, "no Range or custom credential headers")
    assert.equal(options.maxRedirects, 0); assert.equal(options.retry, false)
    assert.equal(options.timeout, 15_000); assert.ok(options.signal instanceof AbortSignal)
    calls.push({ name, params: copy(params) })
    if (input.failAt === name) throw new Error("provider failure synthetic-secret synthetic-refresh")
  }
  const drive = {
    about: { async get(params: AnyRecord, options: AnyRecord) {
      request("about", params, options); assert.deepEqual(params, { fields: "user(emailAddress)" })
      return { data: { user: { emailAddress: input.email ?? fcunoConnectionPolicy.dailyBackupReceipt.googleAccount } } }
    } },
    files: { async list(params: AnyRecord, options: AnyRecord) {
      request("list", params, options); lists++
      assert.equal(params.supportsAllDrives, true); assert.equal(params.corpora, "user")
      if (lists < 3) {
        const item = { id: lists === 1 ? "synthetic-backup-root" : daily, name: lists === 1 ? "Bunker Map Backups" : "Daily Supabase Backups",
          mimeType: "application/vnd.google-apps.folder", trashed: false, parents: [lists === 1 ? "synthetic-root" : "synthetic-backup-root"] }
        assert.equal(params.pageSize, 2)
        assert.ok(params.q.includes(`'${item.parents[0]}' in parents`))
        input.folder?.(item, lists)
        return { data: { files: [item] } }
      }
      assert.equal(params.pageSize, 100); assert.equal(params.orderBy, "createdTime desc")
      assert.ok(params.q.includes(`'${daily}' in parents`))
      const item = copy(file) as AnyRecord
      if (lists > 3) input.after?.(item)
      const result = { files: [item] }
      input.listing?.(result, lists)
      return { data: result }
    }, async get(params: AnyRecord, options: AnyRecord) {
      request("get", params, options); assert.equal(params.fileId, file.id)
      for (const key of ["sha256Checksum", "md5Checksum", "size", "version", "headRevisionId", "appProperties"]) assert.ok(params.fields.split(",").includes(key))
      const item = copy(file) as AnyRecord; input.get?.(item)
      return { data: item }
    } },
  }
  const modules: AnyRecord = {
    "next/server": { NextResponse: { json: Response.json } },
    "@/config/fcunoConnections": { fcunoConnectionPolicy },
    "@/lib/backupAttendanceSchema.mjs": { parseAttendanceBackupSchemaVersion },
    "@/lib/backupPricingSchema.mjs": { parsePricingBackupSchemaVersion },
    "@/lib/adminPages": { isAdminRole: (role: string) => role === "ADMIN" },
    "@/lib/adminAuth": { async requireAdminPagePermission(page: string, permission: string) {
      calls.push({ name: "auth", page, permission }); if (input.authError) throw new Error(input.authError)
      return { role: input.role ?? "ADMIN" }
    } },
    "@/lib/googleApis": { async loadGoogleApis() {
      calls.push({ name: "sdk" })
      return { google: { auth: { OAuth2: class {
        constructor(options: AnyRecord) {
          assert.equal(options.clientId, "synthetic-client"); assert.equal(options.clientSecret, "synthetic-secret")
          assert.ok(options.transporterOptions.signal instanceof AbortSignal)
          assert.equal(options.transporterOptions.maxRedirects, 0); assert.equal(options.transporterOptions.retry, false)
        }
        setCredentials(value: AnyRecord) { assert.deepEqual(value, { refresh_token: "synthetic-refresh" }) }
      } }, drive: () => drive } }
    } },
  }
  function load(path: string) {
    const loaded = { exports: {} as AnyRecord }
    const code = transformSync(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "process", "fetch", "console", code)((name: string) => {
      assert.ok(name in modules, `No unapproved database/media/network dependency: ${name}`); return modules[name]
    }, loaded, loaded.exports, { env }, () => assert.fail("No raw network allowed"), { warn(_message: string, metadata: AnyRecord) { calls.push({ name: "warning", ...metadata }) } })
    return loaded.exports
  }
  modules["@/lib/dailyBackupProviderReceipt"] = load("lib/dailyBackupProviderReceipt.ts")
  const route = load("app/api/admin/system-health/backup-receipt/route.ts")
  return { calls, request: (query = "") => route.GET(new Request(`https://fcuno.com/api/admin/system-health/backup-receipt${query}`)) as Promise<Response> }
}

test("actual route denies anonymous, view-only and non-admin editors before provider work", async () => {
  for (const options of [{ authError: "Unauthorized" }, { authError: "Forbidden" }, { role: "AC" }]) {
    const f = fixture(options), response = await f.request()
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { message: "Forbidden" })
    assert.deepEqual(f.calls, [{ name: "auth", page: "system-health", permission: "edit" }])
    assert.match(response.headers.get("Cache-Control")!, /no-store/)
  }
})
test("actual route rejects caller-chosen files, folders, clients and refresh selectors", async () => {
  for (const query of ["?fileId=other", "?folder=other", "?client=other", "?refresh=1", "?download=1"]) {
    const f = fixture(), response = await f.request(query)
    assert.equal(response.status, 400); assert.equal(f.calls.length, 1)
  }
})
test("actual helper uses only bounded metadata calls and reports the exact limited verification claim", async () => {
  const f = fixture(), response = await f.request(), body = await response.json()
  assert.equal(response.status, 200); assert.equal(body.status, "matched")
  assert.equal(body.verification, "google-drive-checksum-correspondence")
  assert.equal(body.independentByteRead, false); assert.equal(body.restoreTest, false)
  assert.deepEqual(body.backup, { fileId: "synthetic-backup", name: backup().name, createdAt: day, sizeBytes: 2883558296,
    sha256: sha, version: "3", revisionId: "synthetic-revision", migrationHead: "20261027035525", liveTableCount: 67, attendanceSchemaVersion: "annual-v1" })
  assert.deepEqual(f.calls.map(call => call.name), ["auth", "sdk", "about", "list", "list", "list", "get", "list"])
  for (const name of ["Cache-Control", "CDN-Cache-Control", "Vercel-CDN-Cache-Control"]) assert.match(response.headers.get(name)!, /no-store/)
  assert.doesNotMatch(JSON.stringify(body), /synthetic-secret|synthetic-refresh|appProperties|truthHead|emailAddress/)
})
test("source/environment/account guards fail closed before unrelated Drive reads", async () => {
  for (const env of [{ VERCEL: "" }, { VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "other" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://other.supabase.co" }, { GOOGLE_DRIVE_BACKUP_FOLDER_ID: "bad' or 'x" },
    { GOOGLE_OAUTH_CLIENT_SECRET: "" }, { GOOGLE_DRIVE_REFRESH_TOKEN: "" }]) {
    const f = fixture({ env }), response = await f.request(); assert.equal(response.status, 503)
    assert.equal((await response.json()).status, "unknown"); assert.equal(f.calls.some(call => call.name === "sdk"), false)
  }
  const f = fixture({ email: "someone@example.invalid" }), response = await f.request()
  assert.equal(response.status, 503); assert.equal((await response.json()).code, "wrong_account")
  assert.equal(f.calls.some(call => call.name === "list"), false)
})
test("wrong, moved, trashed or mismatched folder ancestry never selects a backup", async () => {
  for (const mutate of [(item: AnyRecord) => { item.parents = ["other"] }, (item: AnyRecord) => { item.trashed = true },
    (item: AnyRecord) => { item.name = "other" }, (item: AnyRecord) => { item.mimeType = "application/json" }]) {
    const f = fixture({ folder: mutate }), response = await f.request(); assert.equal(response.status, 503)
    assert.equal(f.calls.some(call => call.name === "get"), false)
  }
  const f = fixture({ folder: (item, index) => { if (index === 2) item.id = "other-daily" } })
  assert.equal((await f.request()).status, 503)
})
test("incomplete or ambiguous listings cannot choose an older green backup", async () => {
  for (const listing of [(value: AnyRecord) => { value.nextPageToken = "more" }, (value: AnyRecord) => { value.incompleteSearch = true },
    (value: AnyRecord) => { value.files = [] }, (value: AnyRecord) => { value.files.push({ ...value.files[0], id: "other" }) },
    (value: AnyRecord) => { value.files = Array.from({ length: 101 }, () => value.files[0]) }]) {
    const f = fixture({ listing }); assert.equal((await f.request()).status, 503)
  }
})
test("latest complete backup remains selected even if an older backup is valid", async () => {
  const f = fixture({ mutate: file => { file.sha256Checksum = "e".repeat(64) }, listing(value) {
    value.files.push({ ...backup(), id: "older-valid", createdTime: "2026-10-26T19:14:54.575Z" })
  } })
  const response = await f.request(); assert.equal(response.status, 503); assert.equal((await response.json()).code, "checksum_mismatch")
})
test("an in-progress newer upload does not replace the latest complete receipt", async () => {
  const f = fixture({ listing(value) { const newer = backup(); newer.id = "uploading"; newer.createdTime = "2026-10-28T00:00:00.000Z"; newer.appProperties.verificationStatus = "uploading"; value.files.unshift(newer) } })
  assert.equal((await f.request()).status, 200)
})
test("missing provider SHA256 never falls back to MD5 or an uploader hash", async () => {
  for (const sha256Checksum of [undefined, "", "not-a-hash", "A".repeat(64)]) {
    const f = fixture({ mutate: file => { file.sha256Checksum = sha256Checksum } }), response = await f.request()
    assert.equal(response.status, 503); assert.equal((await response.json()).code, "provider_sha256_unavailable")
  }
})
test("provider and receipt metadata corruption is never reported matched", async () => {
  const mutations = [
    (f: AnyRecord) => { f.sha256Checksum = "e".repeat(64) }, (f: AnyRecord) => { f.size = "2883558297" },
    (f: AnyRecord) => { f.size = "0" }, (f: AnyRecord) => { f.size = 2883558296 }, (f: AnyRecord) => { f.size = "9007199254740993" },
    (f: AnyRecord) => { f.version = undefined }, (f: AnyRecord) => { f.headRevisionId = undefined }, (f: AnyRecord) => { f.md5Checksum = "bad" },
    (f: AnyRecord) => { f.parents = ["other"] }, (f: AnyRecord) => { f.trashed = true }, (f: AnyRecord) => { f.createdTime = "not-a-date" },
    (f: AnyRecord) => { f.modifiedTime = "2026-10-26T00:00:00.000Z" }, (f: AnyRecord) => { f.appProperties = undefined },
    ...["artifactSha256", "uploadedFileSha256", "fileByteLength", "truthHeadSequence", "truthHeadSha256", "inventorySha256", "catalogSha256",
      "latestProjectionSnapshotSha256", "migrationHead", "databaseEpoch", "liveTableCount", "sectionCount", "totalRecordCount", "backupRunId", "generatedAt",
      "deploymentCommit", "source", "latestCertificationRunId", "previousFileId", "previousFileName", "previousCreatedTime", "previousArtifactSha256",
      "previousUploadedFileSha256", "verificationContract", "backupSchema"].map(key => (f: AnyRecord) => { f.appProperties[key] = key === "previousFileId" ? "malformed/" : "malformed" }),
    (f: AnyRecord) => { f.appProperties.attendanceSchemaVersion = "invented" }, (f: AnyRecord) => { f.appProperties.pricingSchemaVersion = "invented" },
  ]
  for (const mutate of mutations) {
    const f = fixture({ mutate }), response = await f.request()
    assert.equal(response.status, 503, mutate.toString()); assert.equal((await response.json()).status, "unknown")
  }
})
test("provider metadata and selection are fenced against changes during verification", async () => {
  for (const get of [(f: AnyRecord) => { f.id = "different" }, (f: AnyRecord) => { f.version = "4" }, (f: AnyRecord) => { f.name = "different" }]) {
    assert.equal((await fixture({ get }).request()).status, 503)
  }
  for (const after of [(f: AnyRecord) => { f.id = "newer" }, (f: AnyRecord) => { f.version = "4" }, (f: AnyRecord) => { f.headRevisionId = "changed" },
    (f: AnyRecord) => { f.sha256Checksum = "c".repeat(64) }, (f: AnyRecord) => { f.size = "4" }, (f: AnyRecord) => { f.appProperties.artifactSha256 = "d".repeat(64) }]) {
    const response = await fixture({ after }).request(); assert.equal(response.status, 503); assert.equal((await response.json()).code, "backup_changed")
  }
})
test("provider failures are unknown and never expose credentials or raw errors", async () => {
  for (const failAt of ["about", "list", "get"]) {
    const f = fixture({ failAt }), response = await f.request(), body = await response.json()
    assert.equal(response.status, 503); assert.equal(body.status, "unknown"); assert.equal(body.code, "provider_unavailable")
    assert.doesNotMatch(JSON.stringify([body, f.calls]), /synthetic-secret|synthetic-refresh|provider failure/)
  }
})
