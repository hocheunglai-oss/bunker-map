import test from "node:test"
import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections.ts"
import { createRecoveryBuild, validateRecoveryHostInspection, RECOVERY_WORKSPACE, RECOVERY_POSTGRES_IMAGE } from "../lib/postgresRecoveryBuild.mjs"
import { requireCloudRecoveryAcceptance, validateRecoveryAcceptanceDescriptor } from "../lib/postgresRecoveryAcceptance.mjs"
import { parseCopyHeader, parseSequenceState, parseToc, boundedLines, fingerprintRows } from "../scripts/postgres-recovery/offline.mjs"
import { requirePostgresRecoveryBuildRuntime, createMetadataAccessTokenProvider } from "../scripts/lib/storage-media-job-auth.mjs"
import { validateOfflineRecoveryResult } from "../lib/postgresRecoveryEvidence.mjs"
import { RECOVERY_CATALOG_KEYS, validateRecoveryCatalog } from "../lib/postgresRecoveryCatalog.mjs"
import { POSTGRES_BACKUP_PROTOCOL } from "../lib/postgresBackupProtocol.mjs"
import { main as backupMain } from "../scripts/backup-postgres-to-gcs.mjs"

const now = () => Date.parse("2026-10-28T05:30:00Z")
const context = () => ({ now, signal: AbortSignal.timeout(10000), deadline: now() + 10000 })
const sha = input => createHash("sha256").update(input).digest("hex")
function crc(input) {
  let n = 0xffffffff
  for (const byte of input) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0x82f63b78 : 0) }
  const bytes = Buffer.alloc(4); bytes.writeUInt32BE((n ^ 0xffffffff) >>> 0); return bytes.toString("base64")
}
let manifestReceipt = { target: { bucket: pins.storageMediaBackup.targetBucket, objectName: `${pins.postgresBackup.targetPrefix}/runs/fixture/manifest.json`, generation: "9007199254740993" }, sizeBytes: 100, crc32c: "AAAAAA==", byteSha256: "a".repeat(64) }
const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const publicPem = publicKey.export({ type: "spki", format: "pem" })
const runtime = { FCUNO_POSTGRES_RECOVERY_BUILD: "1", FCUNO_POSTGRES_RECOVERY_BUILD_ID: "11111111-1111-4111-8111-111111111111",
  GOOGLE_CLOUD_PROJECT: pins.storageMediaBackup.googleProjectId, GCS_BACKUP_BUCKET: pins.storageMediaBackup.targetBucket }
function host() { return { Image: `sha256:${"a".repeat(64)}`, Config: { User: "1000:1000", Env: ["PATH=/usr/bin", "LANG=en_US.UTF-8"] },
  State: { Status: "exited", Running: false, ExitCode: 0, OOMKilled: false },
  HostConfig: { NetworkMode: "none", Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 96 },
  Mounts: [["input", "/input", false], ["scratch", "/recovery", true], ["output", "/output", true]].map(([name, Destination, RW]) => ({ Type: "bind", Source: `${RECOVERY_WORKSPACE}/${name}`, Destination, RW })) } }
const metadata = { schema: POSTGRES_BACKUP_PROTOCOL, projectRef: pins.supabase.projectRef, organizationId: pins.supabase.organizationId,
  runId: "11111111-1111-4111-8111-111111111111", startedAt: "2026-10-27T18:15:00.000Z",
  source: { database: "postgres", role: "fcuno_backup_export_login", sessionRole: "fcuno_backup_export_login", serverVersion: "17.6", backendTls: true, clientTls: "verify-full", readOnly: true, snapshot: "00000001-00000002-1" },
  catalog: { tables: [{ schema: "public", name: "fixture", kind: "r", readable: true }],
    roles: [{ rolname: "fcuno_backup_export_login", rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: true,
      rolcanlogin: true, rolinherit: true, rolconnlimit: 2, rolvaliduntil: "2026-11-27T00:00:00Z" }],
    memberships: [{ role: "pg_read_all_data", member: "fcuno_backup_export_login", admin: false, inherit: true, set: false }], database: { name: "postgres" }, extensions: [], largeObjectCount: 0,
    recovery: { ...Object.fromEntries(RECOVERY_CATALOG_KEYS.map(key => [key, []])), sequences: [{}] } } }
const completion = { schema: POSTGRES_BACKUP_PROTOCOL, projectRef: pins.supabase.projectRef, runId: metadata.runId, archiveSha256: "b".repeat(64), archiveBytes: 100,
  metadataSha256: sha(Buffer.from(JSON.stringify(metadata))), finishedAt: "2026-10-27T18:15:01.000Z", dumpExitCode: 0 }
const manifest = { schema: "fcuno.postgresql-copy/v1", status: "copied-and-byte-verified", runId: "fixture", week: "2026-10-26", metadata, completion,
  signature: sign(null, Buffer.from(JSON.stringify(completion)), privateKey).toString("base64url"),
  parts: [{ target: { bucket: pins.storageMediaBackup.targetBucket, objectName: `${pins.postgresBackup.targetPrefix}/runs/fixture/archive/000000`, generation: "1" }, sizeBytes: 100, crc32c: "AAAAAA==", byteSha256: "b".repeat(64) }] }
const manifestBytes = Buffer.from(JSON.stringify(manifest))
manifestReceipt = { ...manifestReceipt, sizeBytes: manifestBytes.length, crc32c: crc(manifestBytes), byteSha256: sha(manifestBytes) }
function result() { return { schema: "fcuno.cloud-postgresql-recovery/v1", status: "isolated-logical-recovery-verified", projectRef: pins.supabase.projectRef,
  archiveSha256: manifest.completion.archiveSha256, archiveBytes: 100, metadataSha256: manifest.completion.metadataSha256, runId: "fixture", week: manifest.week,
  verifiedAt: new Date(now()).toISOString(), runtime: RECOVERY_POSTGRES_IMAGE, tables: 1, tableContentProofSha256: "d".repeat(64), catalogSections: 12,
  tocEntries: 20, unaccountedTocEntries: 0, sequences: 1, sequenceProofSha256: "e".repeat(64), sourceRoleCopiesNoLogin: true, productionConnections: 0,
  excludes: ["hosted-service configuration", "role passwords", "external storage bytes", "Vault root encryption key"] } }
function acceptanceFixture(change = () => {}) {
  const value = { schema: "fcuno.postgresql-recovery-acceptance/v1", status: "cloud-isolated-logical-recovery-verified", manifest: structuredClone(manifestReceipt),
    build: { projectId: pins.storageMediaBackup.googleProjectId, id: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, sourceCommit: "f".repeat(40), imageId: `sha256:${"a".repeat(64)}`, privateLogsDisabled: true, network: "none", credentialsDelegatedToDatabase: false }, result: result() }
  change(value)
  const bytes = Buffer.from(JSON.stringify(value)), receipt = { target: { ...manifestReceipt.target, objectName: manifestReceipt.target.objectName.replace("manifest.json", "recovery.json") }, sizeBytes: bytes.length, crc32c: crc(bytes) }
  const descriptor = { ...receipt, byteSha256: sha(bytes) }
  let inspections = 0
  const gcs = { inspectTarget: async target => { inspections++; if (target.objectName.endsWith("manifest.json")) return Object.fromEntries(Object.entries(manifestReceipt).filter(([key]) => key !== "byteSha256")); return receipt },
    readTarget: async target => { assert.ok(!target.objectName.includes("/archive/"), "activation must not reread archive bytes")
      const isManifest = target.objectName.endsWith("manifest.json"), record = isManifest ? manifestReceipt : receipt
      return { target: record.target, crc32c: record.crc32c, bytes: (async function* () { yield isManifest ? manifestBytes : bytes })() } } }
  return { value, descriptor, gcs, inspections: () => inspections }
}

test("cloud recovery build uses pinned images, existing identity, no logs and no source secrets", () => {
  const build = createRecoveryBuild({ manifestReceipt, verificationKeyPem: publicPem, budgetConfigJson: "{}", sourceCommit: "f".repeat(40) })
  assert.equal(build.options.logging, "NONE"); assert.equal(build.options.diskSizeGb, "100")
  assert.equal(build.serviceAccount, `projects/${pins.storageMediaBackup.googleProjectId}/serviceAccounts/${pins.storageMediaBackup.googleServiceAccount}`)
  assert.equal(build.steps.length, 4); assert.ok(build.steps.every(step => /@sha256:[0-9a-f]{64}$/.test(step.name)))
  assert.equal(build.steps[0].args.at(-1), "download"); assert.equal(build.steps[3].args.at(-1), "publish")
  assert.doesNotMatch(JSON.stringify(build), /PGPASSWORD|SOURCE_CREDENTIAL|SIGNING_KEY|SERVICE_ROLE_KEY|DATABASE_URL/)
  assert.throws(() => createRecoveryBuild({ manifestReceipt, verificationKeyPem: publicPem, budgetConfigJson: "{}", sourceCommit: "main; malicious" }))
})
test("CI host checks private proof only after the sealed container exits and ownership returns", async () => {
  const script = await readFile(new URL("../scripts/postgres-recovery/run-controller-proof.sh", import.meta.url), "utf8")
  const restore = script.lastIndexOf('docker run --name "$recovery_name"')
  const inspect = script.lastIndexOf('docker inspect --format \'{{json .}}\' "$recovery_name"')
  const reclaim = script.lastIndexOf('sudo chown -R "$(id -u):$(id -g)" "$proof_root/output"')
  const check = script.lastIndexOf('test -s "$proof_root/output/recovery.json"')
  assert.ok(restore > 0 && inspect > restore && reclaim > inspect && check > reclaim)
  assert.match(script, /--user 1000:1000 --memory 2g --memory-swap 2g/)
  assert.match(script, /mkdir -m 700/)
  assert.doesNotMatch(script, /chmod.*(?:777|755)/)
})
test("sealed restore host evidence accepts only the exact containment boundary", () => {
  assert.equal(validateRecoveryHostInspection(host()).HostConfig.NetworkMode, "none")
  for (const change of [x => x.HostConfig.NetworkMode = "host", x => x.HostConfig.Privileged = true, x => x.HostConfig.ReadonlyRootfs = false,
    x => x.HostConfig.CapAdd = ["SYS_ADMIN"], x => x.HostConfig.Devices = [{}], x => x.HostConfig.PidMode = "host",
    x => x.HostConfig.SecurityOpt = [], x => x.HostConfig.Memory = 0, x => x.Config.User = "0:0", x => x.Config.Env.push("GOOGLE_TOKEN=secret"),
    x => x.State.ExitCode = 1, x => x.State.OOMKilled = true, x => x.Mounts[0].RW = true, x => x.Mounts.push({ Destination: "/var/run/docker.sock" })]) {
    const value = host(); change(value); assert.throws(() => validateRecoveryHostInspection(value))
  }
})
test("cloud build runtime rejects other projects, local credentials and all source secrets before token IO", async () => {
  requirePostgresRecoveryBuildRuntime(runtime)
  for (const change of [{ GOOGLE_CLOUD_PROJECT: "other" }, { GCS_BACKUP_BUCKET: "other" }, { FCUNO_POSTGRES_RECOVERY_BUILD_ID: "not-build" },
    { CLOUD_RUN_JOB: pins.storageMediaBackup.googleJob }, ...["GOOGLE_APPLICATION_CREDENTIALS", "PGPASSWORD", "DATABASE_URL", "SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON", "POSTGRES_BACKUP_SIGNING_KEY_PEM"].map(key => ({ [key]: "forbidden" }))]) {
    let calls = 0
    const get = createMetadataAccessTokenProvider({ runtime: { ...runtime, ...change }, runtimeMode: "postgres-recovery-build", fetch: async () => { calls++; throw Error("unexpected") } })
    await assert.rejects(get({ signal: AbortSignal.timeout(1000), deadline: Date.now() + 1000 })); assert.equal(calls, 0)
  }
})
test("recovery result binds full proof to exact signed source archive and reports exclusions", () => {
  validateOfflineRecoveryResult(result(), manifest, now())
  for (const change of [{ archiveSha256: "0".repeat(64) }, { metadataSha256: "0".repeat(64) }, { tables: 0 }, { sequences: 0 },
    { unaccountedTocEntries: 1 }, { catalogSections: 11 }, { productionConnections: 1 }, { sourceRoleCopiesNoLogin: false },
    { verifiedAt: "2026-11-28T00:00:00Z" }, { excludes: [] }, { runtime: "newer-unproved-image" }]) assert.throws(() => validateOfflineRecoveryResult({ ...result(), ...change }, manifest, now()))
})
test("first cloud recovery acceptance is private generation/hash pinned and independently read back", async () => {
  const f = acceptanceFixture()
  assert.deepEqual(await requireCloudRecoveryAcceptance(f.gcs, f.descriptor, publicKey, context()), f.value)
  assert.equal(f.inspections(), 4)
  await assert.rejects(requireCloudRecoveryAcceptance(f.gcs, { ...f.descriptor, byteSha256: "0".repeat(64) }, publicKey, context()))
  assert.throws(() => validateRecoveryAcceptanceDescriptor({ ...f.descriptor, target: { ...f.descriptor.target, bucket: "wrong" } }))
})
test("copy-only status, foreign build, stale/future receipt and altered containment never unlock weekly work", async () => {
  for (const change of [x => x.status = "copied-and-byte-verified", x => x.build.network = "default", x => x.build.credentialsDelegatedToDatabase = true,
    x => x.build.privateLogsDisabled = false, x => x.build.projectId = "other", x => x.result.catalogSections = 11, x => x.result.unaccountedTocEntries = 1,
    x => x.result.verifiedAt = "2026-01-01T00:00:00Z", x => x.result.verifiedAt = "2027-01-01T00:00:00Z", x => x.result.runtime = "other",
    x => x.manifest.target.objectName = x.manifest.target.objectName.replace("/fixture/", "/different/"),
    x => x.result.runId = "different", x => x.result.week = "2026-10-19", x => x.result.archiveSha256 = "0".repeat(64),
    x => x.result.metadataSha256 = "0".repeat(64), x => x.result.tables = 0, x => x.result.sequences = 0, x => x.result.extraField = true]) {
    const f = acceptanceFixture(change); await assert.rejects(requireCloudRecoveryAcceptance(f.gcs, f.descriptor, publicKey, context()))
  }
})
test("extension export conditions are aligned and fail closed before source dump or restore", () => {
  for (const condition of [undefined, "WHERE id > 10", "WHERE false", 0]) {
    const catalog = structuredClone(metadata.catalog.recovery)
    catalog.extensionTables = [{ schema: "vault", name: "secrets", extension: "supabase_vault", config: true, condition }]
    assert.throws(() => validateRecoveryCatalog(catalog))
  }
  for (const condition of [null, ""]) {
    const catalog = structuredClone(metadata.catalog.recovery)
    catalog.extensionTables = [{ schema: "vault", name: "secrets", extension: "supabase_vault", config: true, condition }]
    validateRecoveryCatalog(catalog)
  }
})
test("weekly activation without first recovery receipt makes no network request", async () => {
  let calls = 0
  await assert.rejects(backupMain({ args: ["--execute-recurring-weekly"], runtime: {
    CLOUD_RUN_JOB: pins.storageMediaBackup.googleJob, POSTGRES_BACKUP_RECURRING_ENABLED: "1", POSTGRES_BACKUP_VERIFICATION_KEY_PEM: publicPem,
  }, fetch: async () => { calls++; throw Error("must not fetch") } }), /acceptance remains pending/)
  assert.equal(calls, 0)
})
test("COPY and sequence parsing re-quotes identifiers and rejects SQL injection", () => {
  assert.deepEqual(parseCopyHeader('COPY "public"."odd""name" (id, "with space") FROM stdin;'), { schema: "public", name: 'odd"name', columns: ["id", "with space"] })
  for (const value of ["COPY public.x FROM program 'bad';", "COPY public.x (id, id) FROM stdin;", "COPY public.x (id) FROM stdin; SELECT 1;", "COPY public.x (id) TO stdout;"]) assert.throws(() => parseCopyHeader(value))
  assert.deepEqual(parseSequenceState("SELECT pg_catalog.setval('public.sequence', 42, false);"), { schema: "public", name: "sequence", lastValue: "42", isCalled: false })
  assert.throws(() => parseSequenceState("SELECT pg_catalog.setval('public.sequence', 42, false); SELECT 1;"))
  assert.throws(() => parseToc("1; 0 0 TABLE DATA public x owner\n1; 0 0 TABLE DATA public y owner\n"))
})
test("whole-row multiset hashing preserves duplicates and rejects truncated COPY lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fcuno-fingerprint-fixture-"))
  try {
    const run = rows => fingerprintRows((async function* () { for (const row of rows) yield Buffer.from(row) })(), { directory, sortBinary: "/usr/bin/sort", env: { LC_ALL: "C" }, signal: AbortSignal.timeout(3000) })
    assert.deepEqual(await run(["a", "b", "a"]), await run(["a", "a", "b"]))
    assert.notDeepEqual(await run(["a", "b", "a"]), await run(["a", "b"]))
    await assert.rejects(async () => { for await (const line of boundedLines((async function* () { yield Buffer.from("missing newline") })())) assert.ok(line) })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
