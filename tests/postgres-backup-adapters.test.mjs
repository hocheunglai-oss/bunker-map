import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections.ts"
import { POSTGRES_BACKUP_CONTENT_TYPE } from "../lib/postgresBackupProtocol.mjs"
import { createPostgresBackupAdmission } from "../lib/postgresBackupAdmission.mjs"
import { createPostgresBackupRuntimeHandler } from "../lib/postgresBackupRuntime.mjs"
import { createPostgresBackupSourceAdapter } from "../scripts/lib/postgres-backup-source-adapter.mjs"
import { main } from "../scripts/backup-postgres-to-gcs.mjs"

const now = () => Date.parse("2026-10-27T18:15:00Z")
const context = () => ({ now, signal: AbortSignal.timeout(2000), deadline: now() + 2000 })
const owner = "11111111-1111-4111-8111-111111111111", owned = { owner, week: "2026-10-26", fence: 1 }

test("unactivated production wrapper reads no source credential or bundle", async () => {
  const runtime = new Proxy({}, { get(_, key) { if (key !== "POSTGRES_BACKUP_SOURCE_ENABLED") throw Error("must not read source configuration"); return undefined } })
  const denied = () => { throw Error("must not perform IO") }
  const handler = createPostgresBackupRuntimeHandler({ runtime, verifyToken: denied, verifyBundle: denied, fetch: denied })
  assert.equal((await handler(new Request("https://fcuno.com/api/backups/postgres"))).status, 404)
})

test("source admission calls only fixed RPCs and never forwards caller clocks or SQL", async () => {
  const seen = []
  const admission = createPostgresBackupAdmission({ url: `https://${pins.supabase.projectRef}.supabase.co`, serviceRoleKey: "synthetic-source-only",
    fetch: async (url, init) => { seen.push({ url, init }); return Response.json(url.endsWith("claim_fixed_postgresql_export") ? owned : true) } })
  assert.deepEqual(await admission.acquire({ owner, week: owned.week, expiresAt: now() + 2000 }, context()), owned)
  await admission.finish(owned, { exported: true }, context())
  assert.deepEqual(JSON.parse(seen[0].init.body), { p_owner: owner })
  assert.deepEqual(JSON.parse(seen[1].init.body), { p_owner: owner, p_fence: 1, p_exported: true })
  for (const item of seen) { assert.equal(item.init.redirect, "error"); assert.equal(item.init.cache, "no-store"); assert.ok(item.init.signal) }
  await assert.rejects(admission.acquire({ owner, week: owned.week, expiresAt: now() + 2000, sql: "anything" }, context()))
  assert.equal(seen.length, 2)
})
test("admission rejects wrong project, oversized responses and wrong owner/fence", async () => {
  assert.throws(() => createPostgresBackupAdmission({ url: "https://different.supabase.co", serviceRoleKey: "synthetic" }))
  for (const response of [new Response("x".repeat(1025)), Response.json({ ...owned, owner: "wrong" }), Response.json({ ...owned, fence: 0 }), Response.json({}, { status: 401 })]) {
    const admission = createPostgresBackupAdmission({ url: `https://${pins.supabase.projectRef}.supabase.co`, serviceRoleKey: "synthetic",
      fetch: async () => response })
    await assert.rejects(admission.acquire({ owner, week: owned.week, expiresAt: now() + 1000 }, context()))
  }
})
test("Google client sends one fixed request and cancellation closes even an unread stream", async () => {
  let cancelled = 0, calls = 0
  const source = createPostgresBackupSourceAdapter({ now, getIdentityToken: async () => "aaa.bbb.ccc", fetch: async (url, init) => {
    calls++
    assert.equal(url, `${pins.vercel.productionOrigins[0]}${pins.postgresBackup.sourcePath}`)
    assert.equal(init.body, '{"operation":"weekly-full-v1"}'); assert.equal(init.redirect, "error")
    assert.equal(init.headers.Authorization, "Bearer aaa.bbb.ccc")
    return new Response(new ReadableStream({ cancel() { cancelled++ } }, { highWaterMark: 0 }),
      { headers: { "Content-Type": POSTGRES_BACKUP_CONTENT_TYPE, "Cache-Control": "private, no-store" } })
  } })
  const opened = await source.open(context()); opened.close(); opened.close()
  assert.equal(calls, 1); assert.equal(cancelled, 1)
})
test("Google client rejects altered/error/encoded response and has no credential fallback", async () => {
  for (const overrides of [{ status: 302 }, { headers: { "content-type": "text/plain" } }, { headers: { "content-encoding": "gzip" } },
    { headers: { "content-length": "10" } }, { headers: { "content-range": "bytes 0-9/10" } }, { headers: { "cache-control": "public" } }]) {
    const source = createPostgresBackupSourceAdapter({ now, getIdentityToken: async () => "aaa.bbb.ccc",
      fetch: async () => new Response("PGDMPdata", { status: overrides.status || 200, headers: {
        "content-type": POSTGRES_BACKUP_CONTENT_TYPE, "cache-control": "private, no-store", ...overrides.headers } }) })
    await assert.rejects(source.open(context()))
  }
})
test("weekly job cannot run locally, activate implicitly or receive source secrets", async () => {
  let calls = 0
  const fetch = async () => { calls++; throw Error("must not fetch") }
  await assert.rejects(main({ args: [], runtime: {}, fetch }))
  await assert.rejects(main({ args: ["--execute-recurring-weekly"], runtime: {}, fetch }))
  const runtime = { CLOUD_RUN_JOB: pins.storageMediaBackup.googleJob, GOOGLE_CLOUD_PROJECT: pins.storageMediaBackup.googleProjectId,
    GCS_BACKUP_BUCKET: pins.storageMediaBackup.targetBucket, POSTGRES_BACKUP_RECURRING_ENABLED: "1" }
  for (const name of ["PGPASSWORD", "DATABASE_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY",
    "POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON", "POSTGRES_BACKUP_SIGNING_KEY_PEM"]) {
    await assert.rejects(main({ args: ["--execute-recurring-weekly"], runtime: { ...runtime, [name]: "synthetic" }, fetch }))
  }
  assert.equal(calls, 0)
  const docker = await readFile(new URL("../Dockerfile.drive-backup", import.meta.url), "utf8")
  assert.doesNotMatch(docker, /COPY.*postgres-backup-native|COPY.*postgresBackupAdmission|COPY.*postgresBackupCapability/)
})
