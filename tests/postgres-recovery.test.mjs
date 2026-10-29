import test from "node:test"
import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, readFile, rm, mkdir, writeFile, chmod, realpath, stat, symlink } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections.ts"
import { createRecoveryBuild, validateRecoveryHostInspection, RECOVERY_WORKSPACE, RECOVERY_POSTGRES_IMAGE } from "../lib/postgresRecoveryBuild.mjs"
import { requireCloudRecoveryAcceptance, validateRecoveryAcceptanceDescriptor } from "../lib/postgresRecoveryAcceptance.mjs"
import { parseCopyHeader, parseSequenceState, parseToc, boundedLines, fingerprintRows, runOfflineRecovery } from "../scripts/postgres-recovery/offline.mjs"
import { createRecoveryDiagnostics, createNativeStderrHint, validateRecoveryDiagnostic, validateRecoveryFailureHost, recoveryFailure } from "../lib/postgresRecoveryDiagnostics.mjs"
import { recordRecoveryFailureAndReject, RECOVERY_CONTROLLER_EXIT_CODES, createRecoveryControllerStages, readRecoveryPublicationInputs, readRecoveryHostOutcome, recoveryPublicationFailed, runCloudRecoveryCli } from "../scripts/postgres-recovery/cloud.mjs"
import { createStorageMediaGcsAdapter } from "../scripts/lib/storage-media-gcs-adapter.mjs"
import { requirePostgresRecoveryBuildRuntime, createMetadataAccessTokenProvider } from "../scripts/lib/storage-media-job-auth.mjs"
import { validateOfflineRecoveryResult } from "../lib/postgresRecoveryEvidence.mjs"
import { RECOVERY_CATALOG_KEYS, validateRecoveryCatalog } from "../lib/postgresRecoveryCatalog.mjs"
import { equivalentRecoveryColumns } from "../lib/postgresRecoveryColumns.mjs"
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

test("recovery columns compare visible ordinals without hiding missing, reordered or changed catalog fields", () => {
  const column = (name, position, overrides = {}) => ({ schema: "public", relation: "fixture", name, position,
    type: "text", not_null: false, identity: "", generated: "", storage: "x", compression: "",
    default: null, collation: "default", collation_schema: "pg_catalog", comment: null, ...overrides })
  const source = [column("id", 2), column("body", 4), column("extra", 6), column("other", 1, { relation: "other" })]
  const restored = [column("id", 1), column("body", 2), column("extra", 3), column("other", 1, { relation: "other" })]
  const unchanged = JSON.stringify({ source, restored })
  source.forEach(Object.freeze); restored.forEach(Object.freeze); Object.freeze(source); Object.freeze(restored)
  assert.equal(equivalentRecoveryColumns(source, restored), true)
  assert.equal(equivalentRecoveryColumns(restored, source), true)
  assert.equal(equivalentRecoveryColumns([], []), true)
  assert.equal(JSON.stringify({ source, restored }), unchanged, "signed input must not be mutated")
  // Object-key order is not a schema change; array order remains meaningful.
  assert.equal(equivalentRecoveryColumns(source, restored.map(item => Object.fromEntries(Object.entries(item).reverse()))), true)
  for (const [label, change] of [
    ["missing", rows => rows.splice(1, 1)], ["extra", rows => rows.splice(3, 0, column("added", 4))],
    ["reordered names", rows => { [rows[0].name, rows[1].name] = [rows[1].name, rows[0].name] }],
    ["renamed", rows => { rows[1].name = "changed" }], ["type", rows => { rows[1].type = "integer" }],
    ["nullability", rows => { rows[1].not_null = true }], ["default", rows => { rows[1].default = "'x'::text" }],
    ["identity", rows => { rows[1].identity = "a" }], ["generated", rows => { rows[1].generated = "s" }],
    ["storage", rows => { rows[1].storage = "p" }], ["compression", rows => { rows[1].compression = "p" }],
    ["collation", rows => { rows[1].collation = "C" }], ["collation schema", rows => { rows[1].collation_schema = "public" }],
    ["comment", rows => { rows[1].comment = "changed" }], ["missing field", rows => { delete rows[1].comment }],
    ["unknown future field", rows => { rows[1].future = { value: [1, 2] } }],
    ["relation order", rows => { rows.unshift(rows.pop()) }],
  ]) {
    const changed = structuredClone(restored); change(changed)
    assert.equal(equivalentRecoveryColumns(source, changed), false, label)
  }
  const futureSource = structuredClone(source), futureRestored = structuredClone(restored)
  futureSource[0].future = { value: [1, 2] }; futureRestored[0].future = { value: [1, 2] }
  assert.equal(equivalentRecoveryColumns(futureSource, futureRestored), true)
  futureRestored[0].future.value.reverse()
  assert.equal(equivalentRecoveryColumns(futureSource, futureRestored), false)
  for (const badPosition of [0, -1, 1.5, "1", null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidRows = structuredClone(restored); invalidRows[0].position = badPosition
    assert.throws(() => equivalentRecoveryColumns(invalidRows, restored), /Recovery column metadata invalid/)
    assert.throws(() => equivalentRecoveryColumns(restored, invalidRows), /Recovery column metadata invalid/)
  }
  for (const change of [
    rows => { rows[1].position = rows[0].position }, rows => { rows[1].position = 1 },
    rows => { [rows[0], rows[1]] = [rows[1], rows[0]] },
    rows => { rows.splice(1, 0, rows.pop()) }, rows => { rows[1].name = rows[0].name },
    rows => { rows[0].schema = "" }, rows => { rows[0].relation = "bad\0name" },
    rows => { rows[0].name = null }, rows => { delete rows[0].position }, rows => { rows[0] = null },
    rows => { rows[0] = [] }, rows => { rows[0] = Object.assign(Object.create(null), rows[0]) },
  ]) {
    const invalidRows = structuredClone(restored); change(invalidRows)
    assert.throws(() => equivalentRecoveryColumns(invalidRows, restored), /Recovery column metadata invalid/)
  }
  for (const invalidRows of [null, {}, "", Array(100001)])
    assert.throws(() => equivalentRecoveryColumns(invalidRows, restored), /Recovery column metadata invalid/)
})

test("cloud recovery build uses pinned images, existing identity, no logs and no source secrets", () => {
  const build = createRecoveryBuild({ manifestReceipt, verificationKeyPem: publicPem, budgetConfigJson: "{}", sourceCommit: "f".repeat(40) })
  assert.equal(build.options.logging, "NONE"); assert.equal(build.options.diskSizeGb, "100")
  assert.equal(build.serviceAccount, `projects/${pins.storageMediaBackup.googleProjectId}/serviceAccounts/${pins.storageMediaBackup.googleServiceAccount}`)
  assert.equal(build.steps.length, 4); assert.ok(build.steps.every(step => /@sha256:[0-9a-f]{64}$/.test(step.name)))
  assert.equal(build.steps[0].args.at(-1), "download"); assert.equal(build.steps[3].args.at(-1), "publish")
  assert.equal(build.steps[2].allowFailure, true, "continue only to mandatory private failure recording")
  assert.equal(build.steps[3].allowFailure, undefined)
  assert.equal(build.steps[3].allowExitCodes, undefined, "publisher failure must fail the Build")
  assert.doesNotMatch(JSON.stringify(build), /PGPASSWORD|SOURCE_CREDENTIAL|SIGNING_KEY|SERVICE_ROLE_KEY|DATABASE_URL/)
  assert.throws(() => createRecoveryBuild({ manifestReceipt, verificationKeyPem: publicPem, budgetConfigJson: "{}", sourceCommit: "main; malicious" }))
})

test("private diagnostics accept fixed enums only and never retain raw errors or SQL", async () => {
  const saved = [], trace = createRecoveryDiagnostics({ now, save: async value => saved.push(value) })
  await trace.stage("restore-archive")
  trace.native("pgRestore", 17, "SECRET_SQL")
  await trace.failed(new Error("SECRET_SQL business row password"))
  assert.deepEqual(trace.snapshot().native, { program: "pgRestore", exitCode: 17, signal: null, stderrHint: "generic" })
  assert.doesNotMatch(JSON.stringify(saved), /SECRET_SQL|business row|password/)
  await assert.rejects(trace.stage("SELECT private_data"))
  assert.throws(() => trace.native("/private/secret", 1, null))
  for (const mutate of [v => v.error = "private", v => v.stage = "private", v => v.native.stderr = "private", v => v.native.signal = "private", v => v.catalog = [{ section: "private", expectedCount: 1, actualCount: 1, equal: false }]]) {
    const value = trace.snapshot(); mutate(value); assert.throws(() => validateRecoveryDiagnostic(value))
  }
})

test("catalog diagnostics contain only twelve fixed section counts and equality flags", async () => {
  const expected = Object.fromEntries(RECOVERY_CATALOG_KEYS.map(key => [key, []])), actual = structuredClone(expected)
  expected.columns = [{ privateSql: "do not publish" }]; actual.columns = [{ privateSql: "different secret" }]
  const trace = createRecoveryDiagnostics({ now })
  const checkedSections = []
  await trace.catalog(expected, actual, (a, b, section) => { checkedSections.push(section); return JSON.stringify(a) === JSON.stringify(b) })
  assert.deepEqual(checkedSections, RECOVERY_CATALOG_KEYS)
  assert.equal(trace.snapshot().catalog.length, 12)
  assert.deepEqual(trace.snapshot().catalog.find(value => value.section === "columns"), { section: "columns", expectedCount: 1, actualCount: 1, equal: false })
  assert.doesNotMatch(JSON.stringify(trace.snapshot()), /publish|secret|privateSql/)
})

test("native stderr hints are bounded heuristic enums and cannot publish private text", () => {
  for (const [line, expected] of [["ERROR: permission denied for table SECRET_BUSINESS", "permission-denied"],
    ["ERROR: relation SECRET_BUSINESS already exists", "object-exists"], ["ERROR: relation SECRET_BUSINESS does not exist", "missing-object"],
    ["ERROR: unrecognized configuration parameter SECRET_BUSINESS", "unsupported-setting"],
    ["ERROR: canceling statement due to statement timeout", "statement-timeout"], ["FATAL: out of memory SECRET_BUSINESS", "memory"],
    ["SECRET_BUSINESS arbitrary failure", "generic"]]) {
    const hint = createNativeStderrHint()
    hint.write(Buffer.from("private prefix".repeat(10000))); hint.write(Buffer.from(line.slice(0, 8))); hint.write(Buffer.from(line.slice(8)))
    assert.equal(hint.value(), expected)
    const trace = createRecoveryDiagnostics({ now }); trace.native("pgRestore", 1, null, hint.value())
    assert.doesNotMatch(JSON.stringify(trace.snapshot()), /SECRET_BUSINESS|private prefix|ERROR|FATAL/)
    assert.equal(Object.hasOwn(trace.snapshot().native, "stderr"), false)
  }
  const trace = createRecoveryDiagnostics({ now }); trace.native("pgRestore", 1, null, "private text"); assert.equal(trace.snapshot().native.stderrHint, "generic")
})

test("host failure diagnostics reject extra inspect fields and distinguish OOM/missing outcomes", async () => {
  const outcome = { schema: "fcuno.private-recovery-host-outcome/v1", dockerRunExitCode: 0,
    state: { Status: "exited", Running: false, ExitCode: 0, OOMKilled: false } }
  const trace = createRecoveryDiagnostics({ now }); await trace.cleanup("ok"); await trace.complete()
  assert.equal(recoveryFailure({ host: outcome, diagnostic: trace.snapshot() }), false)
  for (const change of [v => v.dockerRunExitCode = 1, v => v.state.ExitCode = 137, v => v.state.OOMKilled = true, v => v.state = null]) {
    const value = structuredClone(outcome); change(value); assert.equal(recoveryFailure({ host: value, diagnostic: trace.snapshot() }), true)
  }
  assert.equal(recoveryFailure({ host: outcome, diagnostic: null }), true)
  await trace.cleanup("failed"); assert.equal(recoveryFailure({ host: outcome, diagnostic: trace.snapshot() }), true)
  for (const change of [v => v.Error = "secret", v => v.state.Error = "secret", v => v.state.ExitCode = "secret", v => v.state.Status = "secret"]) {
    const value = structuredClone(outcome); change(value); assert.throws(() => validateRecoveryFailureHost(value))
  }
})

test("actual offline verifier records a fake native failure without storing its stderr", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fcuno-diagnostic-unit-")))
  try {
    const archivePath = join(directory, "fixture.dump"), executable = join(directory, "fake-initdb")
    const bytes = Buffer.from("PGDMP synthetic unit data")
    await writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" })
    await writeFile(executable, '#!/bin/sh\nprintf "SECRET_PRIVATE_SQL_AND_ROW\\n" >&2\nexit 17\n', { mode: 0o700, flag: "wx" })
    await chmod(executable, 0o700)
    const m = structuredClone(manifest)
    m.metadata.catalog.roles.push({ oid: 10, rolname: "synthetic_bootstrap", rolsuper: true })
    m.completion.archiveSha256 = sha(bytes); m.completion.archiveBytes = bytes.length
    m.completion.metadataSha256 = sha(Buffer.from(JSON.stringify(m.metadata)))
    m.signature = sign(null, Buffer.from(JSON.stringify(m.completion)), privateKey).toString("base64url")
    m.parts[0].sizeBytes = bytes.length; m.parts[0].byteSha256 = sha(bytes)
    const snapshots = [], trace = createRecoveryDiagnostics({ save: async value => snapshots.push(value) })
    await assert.rejects(runOfflineRecovery({ archivePath, manifest: m, publicKey, workRoot: directory, diagnostics: trace,
      signal: AbortSignal.timeout(5000), binaries: Object.fromEntries(["initdb", "pgCtl", "psql", "pgRestore", "sort"].map(key => [key, executable])) }), /Isolated native recovery command failed/)
    assert.equal(trace.snapshot().stage, "initdb"); assert.equal(trace.snapshot().status, "failed"); assert.equal(trace.snapshot().cleanup, "ok")
    assert.deepEqual(trace.snapshot().native, { program: "initdb", exitCode: 17, signal: null, stderrHint: "generic" })
    assert.doesNotMatch(JSON.stringify(snapshots), /SECRET_PRIVATE_SQL_AND_ROW|synthetic_bootstrap|fixture\.dump/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("failed diagnostic persistence cannot skip owned server cleanup or mask primary failure", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "fcuno-diagnostic-cleanup-unit-")))
  try {
    const archivePath = join(directory, "fixture.dump"), marker = join(directory, "stopped")
    const bytes = Buffer.from("PGDMP synthetic cleanup data"), binaries = {}
    await writeFile(archivePath, bytes, { mode: 0o600 })
    for (const name of ["initdb", "pgCtl", "psql", "pgRestore", "sort"]) {
      const path = join(directory, name); binaries[name] = path
      const body = name === "psql" ? 'exit 17' : name === "pgCtl" ? `case " $* " in *" stop "*) printf stopped > '${marker}';; esac\nexit 0` : 'exit 0'
      await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 }); await chmod(path, 0o700)
    }
    const m = structuredClone(manifest); m.metadata.catalog.roles.push({ oid: 10, rolname: "synthetic_bootstrap", rolsuper: true })
    m.completion.archiveSha256 = sha(bytes); m.completion.archiveBytes = bytes.length; m.completion.metadataSha256 = sha(Buffer.from(JSON.stringify(m.metadata)))
    m.signature = sign(null, Buffer.from(JSON.stringify(m.completion)), privateKey).toString("base64url"); m.parts[0].sizeBytes = bytes.length; m.parts[0].byteSha256 = sha(bytes)
    const trace = createRecoveryDiagnostics({ save: async value => { if (value.status === "failed" || value.cleanup !== "not-started") throw Error("synthetic diagnostic disk full") } })
    await assert.rejects(runOfflineRecovery({ archivePath, manifest: m, publicKey, workRoot: directory, diagnostics: trace, binaries, signal: AbortSignal.timeout(5000) }), /Isolated native recovery command failed/)
    assert.equal(await readFile(marker, "utf8"), "stopped")
    assert.equal(trace.snapshot().stage, "create-operator"); assert.equal(trace.snapshot().cleanup, "ok")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("shell retains safe host outcome before cleanup and preserves failure exit", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fcuno-diagnostic-shell-unit-")))
  try {
    const work = join(root, "work"), bin = join(root, "bin"), journal = join(root, "calls.jsonl")
    await mkdir(work); await mkdir(bin)
    const script = (await readFile(new URL("../scripts/postgres-recovery/run-cloud-isolated.sh", import.meta.url), "utf8"))
      .replace("work=/workspace/.fcuno-postgres-recovery", `work='${work}'`)
    await writeFile(join(root, "run.sh"), script, { mode: 0o600 })
    // Render the four actual format placeholders instead of returning a
    // hard-coded valid JSON object. Missing literal braces in the shell's Go
    // template must therefore break JSON.parse here, as they do with Docker.
    await writeFile(join(bin, "docker"), `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(args)+'\\n');\nif(args[0]==='run')process.exit(1);\nif(args[0]==='inspect'){const state={Status:'exited',Running:false,ExitCode:1,OOMKilled:false};if(args[2]==='{{json .}}')throw Error('full failure inspect forbidden');const rendered=args[2].replace(/\\{\\{json \\.State\\.(Status|Running|ExitCode|OOMKilled)\\}\\}/g,(_,key)=>JSON.stringify(state[key]));if(rendered.includes('{{'))throw Error('unknown synthetic template');process.stdout.write(rendered);}\n`, { mode: 0o700 })
    await chmod(join(bin, "docker"), 0o700)
    await assert.rejects(promisify(execFile)("/bin/bash", [join(root, "run.sh")], { env: { PATH: `${bin}:/usr/bin:/bin` } }), error => error.code === 1)
    const outcome = JSON.parse(await readFile(join(work, "host-outcome.json"), "utf8")); validateRecoveryFailureHost(outcome)
    assert.equal(outcome.dockerRunExitCode, 1); assert.equal(outcome.state.OOMKilled, false)
    assert.equal((await stat(join(work, "host-outcome.json"))).mode & 0o777, 0o600)
    const calls = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse)
    assert.deepEqual(calls.map(call => call[0]), ["run", "inspect", "rm"])
    assert.ok(calls[0].includes("none")); assert.ok(calls[0].includes("--read-only")); assert.ok(calls[0].includes("2g"))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("failed restore writes immutable build-specific failure then rejects, never acceptance", async () => {
  const buildId = runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, calls = [], trace = createRecoveryDiagnostics({ now })
  await trace.stage("verify-catalog"); await trace.failed(); await trace.cleanup("ok")
  let recorded, receipt
  const host = { schema: "fcuno.private-recovery-host-outcome/v1", dockerRunExitCode: 1,
    state: { Status: "exited", Running: false, ExitCode: 1, OOMKilled: false } }
  const gcs = {
    uploadImmutable: async () => { throw Error("Acceptance forbidden") },
    uploadRecoveryFailure: async input => {
      calls.push("failure-only"); recorded = input.bytes
      assert.equal(input.buildId, buildId)
      receipt = { target: { ...manifestReceipt.target, objectName: manifestReceipt.target.objectName.replace("manifest.json", `failures/${buildId}.json`), generation: "123" },
        sizeBytes: recorded.length, crc32c: crc(recorded) }
      return receipt
    },
    readTarget: async () => { calls.push("readback"); return { ...receipt, bytes: (async function* () { yield recorded })() } },
    inspectTarget: async () => { calls.push("inspect"); return receipt },
  }
  await assert.rejects(recordRecoveryFailureAndReject({ gcs, context: context(), plan: { manifest: manifestReceipt, buildId, sourceCommit: "f".repeat(40) }, host, diagnostic: trace.snapshot() }), /Isolated recovery failed; private diagnostic recorded/)
  assert.deepEqual(calls, ["failure-only", "readback", "inspect"])
  const report = JSON.parse(recorded); assert.equal(report.recoveryVerified, false); assert.equal(report.status, "cloud-isolated-recovery-failed")
  assert.throws(() => validateOfflineRecoveryResult(report, manifest, now()))
  assert.throws(() => validateRecoveryAcceptanceDescriptor({ ...receipt, byteSha256: sha(recorded) }))
  const build = createRecoveryBuild({ manifestReceipt, verificationKeyPem: publicPem, budgetConfigJson: "{}", sourceCommit: "f".repeat(40) })
  assert.equal(build.steps[2].allowFailure, true); assert.equal(build.steps[3].allowFailure, undefined); assert.equal(build.steps[3].allowExitCodes, undefined)
})

test("failure publisher rejects contaminated diagnostics before any write", async () => {
  let writes = 0
  await assert.rejects(recordRecoveryFailureAndReject({ gcs: { uploadRecoveryFailure: async () => { writes++ } }, context: context(),
    plan: { manifest: manifestReceipt, buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, sourceCommit: "f".repeat(40) }, host: null,
    diagnostic: { ...createRecoveryDiagnostics({ now }).snapshot(), stderr: "secret SQL" } }))
  assert.equal(writes, 0)
})

test("failure publisher rejects changed name, generation, bytes and final metadata", async () => {
  const buildId = runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID
  for (const changed of ["name", "generation", "bytes", "inspect"]) {
    let bytes, receipt
    const gcs = { uploadImmutable: async () => { throw Error("acceptance forbidden") },
      uploadRecoveryFailure: async input => {
        bytes = input.bytes; receipt = { target: { ...manifestReceipt.target, objectName: manifestReceipt.target.objectName.replace("manifest.json", `failures/${buildId}.json`), generation: "123" }, sizeBytes: bytes.length, crc32c: crc(bytes) }
        return changed === "name" ? { ...receipt, target: { ...receipt.target, objectName: "recovery.json" } } : receipt
      },
      readTarget: async () => ({ ...receipt, target: changed === "generation" ? { ...receipt.target, generation: "124" } : receipt.target,
        bytes: (async function* () { yield changed === "bytes" ? Buffer.alloc(bytes.length) : bytes })() }),
      inspectTarget: async () => changed === "inspect" ? { ...receipt, target: { ...receipt.target, generation: "124" } } : receipt }
    await assert.rejects(recordRecoveryFailureAndReject({ gcs, context: context(), plan: { manifest: manifestReceipt, buildId, sourceCommit: "f".repeat(40) }, host: null, diagnostic: null }),
      error => !error.message.includes("private diagnostic recorded"))
  }
})

test("failure upload adapter rejects traversal, acceptance overwrite and other modes before network", async () => {
  let calls = 0
  const fetch = async () => { calls++; throw Error("unexpected network") }, getAccessToken = async () => { calls++; throw Error("unexpected token") }
  for (const mode of ["approved-snapshot", "recurring", "postgres-candidate"]) {
    const gcs = createStorageMediaGcsAdapter({ mode, runId: "fixture", fetch, getAccessToken })
    await assert.rejects(gcs.uploadRecoveryFailure({ buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, bytes: Buffer.from("{}") }, context()))
  }
  const gcs = createStorageMediaGcsAdapter({ mode: "postgres-recovery", runId: "fixture", fetch, getAccessToken })
  for (const buildId of ["../recovery", "recovery.json", "private", runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID + "/../../recovery.json"]) {
    await assert.rejects(gcs.uploadRecoveryFailure({ buildId, bytes: Buffer.from("{}") }, context()))
  }
  await assert.rejects(gcs.uploadRecoveryFailure({ buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, bytes: Buffer.alloc(16385) }, context()))
  await assert.rejects(gcs.uploadRecoveryFailure({ buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, bytes: Buffer.from("{}"), objectName: "recovery.json" }, context()))
  await assert.rejects(gcs.uploadRecoveryFailure({ buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, bytes: Buffer.from("{}"), ifGenerationMatch: "123" }, context()))
  assert.equal(calls, 0)
})

test("failure adapter creates only exact run/build object using generation-zero precondition", async () => {
  const calls = [], bytes = Buffer.from('{"status":"synthetic-failed"}'), buildId = runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID
  const expectedName = `${pins.postgresBackup.targetPrefix}/runs/fixture/failures/${buildId}.json`
  const gcs = createStorageMediaGcsAdapter({ mode: "postgres-recovery", runId: "fixture", now, getAccessToken: async () => "synthetic-token",
    fetch: async (input, init = {}) => {
      const url = new URL(input); calls.push({ url, init })
      if (url.pathname.startsWith("/storage/v1/b/")) return Response.json({ name: pins.storageMediaBackup.targetBucket,
        location: pins.storageMediaBackup.googleRegion.toUpperCase(), versioning: { enabled: true },
        iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } } })
      assert.equal(init.method, "POST"); assert.equal(url.searchParams.get("ifGenerationMatch"), "0")
      assert.equal(url.searchParams.get("name"), expectedName)
      assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), bytes)
      return Response.json({ bucket: pins.storageMediaBackup.targetBucket, name: expectedName, generation: "123", size: String(bytes.length), crc32c: crc(bytes) })
    } })
  const saved = await gcs.uploadRecoveryFailure({ buildId, bytes }, context())
  assert.equal(saved.target.objectName, expectedName); assert.equal(calls.length, 2)
  assert.ok(calls.every(call => !call.url.href.includes("recovery.json")))
})

test("controller stage exit codes are fixed, nonzero and reject adversarial stage values", () => {
  const values = Object.values(RECOVERY_CONTROLLER_EXIT_CODES)
  assert.ok(values.every(value => Number.isInteger(value) && value > 1 && value < 126))
  assert.equal(new Set(values).size, values.length)
  const trace = createRecoveryControllerStages()
  for (const [stage, code] of Object.entries(RECOVERY_CONTROLLER_EXIT_CODES)) { trace.enter(stage); assert.equal(trace.exitCode(), code) }
  for (const value of ["__proto__", "constructor", "toString", "complete", "0", 0, null, undefined, {}, { toString() { throw Error("private") } }, "private SQL\npassword"]) {
    assert.throws(() => trace.enter(value)); assert.equal(trace.exitCode(), 90)
  }
  assert.ok(Object.isFrozen(RECOVERY_CONTROLLER_EXIT_CODES)); assert.ok(Object.isFrozen(trace))
})

test("controller CLI ignores exception-supplied codes and untrusted stage overrides", async () => {
  const confidential = new Error("private SQL password token")
  confidential.exitCode = 0; confidential.code = 0; confidential.stage = "failure-recorded"
  let calls = 0
  const fetch = async () => { calls++; throw confidential }, stage = () => { throw confidential }
  assert.equal(await runCloudRecoveryCli({ args: ["private SQL"], runtime, fetch, stage }), 20)
  assert.equal(await runCloudRecoveryCli({ args: ["publish"], runtime: {}, fetch, stage }), 21)
  assert.equal(await runCloudRecoveryCli({ args: ["publish"], runtime, fetch, stage }), 22)
  const hostile = { get GOOGLE_CLOUD_PROJECT() { throw confidential } }
  assert.equal(await runCloudRecoveryCli({ args: ["publish"], runtime: hostile, fetch, stage }), 21)
  assert.equal(calls, 0)
})

test("publisher preflight exercises real private files and reports exact failing boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "fcuno-publish-preflight-"))
  const pubRuntime = { ...runtime, FCUNO_RECOVERY_SOURCE_COMMIT: "f".repeat(40), POSTGRES_BACKUP_VERIFICATION_KEY_PEM: publicPem }
  const plan = { buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, sourceCommit: pubRuntime.FCUNO_RECOVERY_SOURCE_COMMIT,
    manifest: manifestReceipt, verificationKeySha256: sha(Buffer.from(publicPem)) }
  const failedHost = { schema: "fcuno.private-recovery-host-outcome/v1", dockerRunExitCode: 1,
    state: { Status: "exited", Running: false, ExitCode: 1, OOMKilled: false } }
  const json = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 })
  const cases = [
    [30, async dir => rm(join(dir, "plan.json"))],
    [30, async dir => writeFile(join(dir, "plan.json"), "{")],
    [30, async dir => { await rm(join(dir, "plan.json")); await symlink(join(dir, "input/manifest.json"), join(dir, "plan.json")) }],
    [30, async dir => writeFile(join(dir, "plan.json"), Buffer.alloc(16385))],
    [31, async dir => json(join(dir, "plan.json"), { ...plan, buildId: "different-build" })],
    [31, async dir => json(join(dir, "plan.json"), { ...plan, verificationKeySha256: "0".repeat(64) })],
    [32, async dir => rm(join(dir, "input/manifest.json"))],
    [32, async dir => writeFile(join(dir, "input/manifest.json"), Buffer.alloc(pins.postgresBackup.maximumMetadataBytes + 1))],
    [32, async dir => writeFile(join(dir, "input/manifest.json"), "{")],
    [33, async dir => json(join(dir, "input/manifest.json"), { ...manifest, signature: "a".repeat(86) })],
    [33, async dir => json(join(dir, "input/manifest.json"), { ...manifest, runId: "different-run" })],
    [34, async dir => writeFile(join(dir, "output/diagnostic.json"), "{")],
    [34, async dir => symlink(join(dir, "input/manifest.json"), join(dir, "output/diagnostic.json"))],
    [34, async dir => mkdir(join(dir, "output/diagnostic.json"))],
    [35, async dir => json(join(dir, "output/diagnostic.json"), { ...createRecoveryDiagnostics({ now }).snapshot(), stage: "private SQL" })],
  ]
  try {
    for (let index = 0; index < cases.length + 2; index++) {
      const dir = join(root, String(index)); await mkdir(dir, { mode: 0o700 })
      await mkdir(join(dir, "input"), { mode: 0o700 }); await mkdir(join(dir, "output"), { mode: 0o700 })
      await json(join(dir, "plan.json"), plan); await writeFile(join(dir, "input/manifest.json"), manifestBytes, { mode: 0o600 })
      if (index !== cases.length) await json(join(dir, "host-outcome.json"), failedHost)
      const trace = createRecoveryControllerStages()
      const input = { workspace: dir, runtime: pubRuntime, descriptor: manifestReceipt, publicKey, stage: trace.enter }
      if (index < cases.length) {
        await cases[index][1](dir); await assert.rejects(readRecoveryPublicationInputs(input))
        assert.equal(trace.exitCode(), cases[index][0], `case ${index}`)
      } else {
        const result = await readRecoveryPublicationInputs(input)
        assert.equal(result.diagnostic, null); assert.deepEqual(result.hostOutcome, index === cases.length ? null : failedHost)
        assert.equal(result.hostReadStatus, index === cases.length ? "missing" : "valid")
        assert.equal(trace.exitCode(), 35); assert.deepEqual(result.manifest, manifest)
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("host outcome read failures retain fixed statuses without private data or symlink following", async () => {
  const root = await mkdtemp(join(tmpdir(), "fcuno-host-read-"))
  const value = { schema: "fcuno.private-recovery-host-outcome/v1", dockerRunExitCode: 1,
    state: { Status: "exited", Running: false, ExitCode: 1, OOMKilled: false } }
  try {
    const path = join(root, "host.json")
    assert.deepEqual(await readRecoveryHostOutcome(path), { status: "missing", host: null })
    for (const [bytes, expected] of [["", "invalid-json"], ["{PRIVATE_SQL_PASSWORD", "invalid-json"],
      ["null", "invalid-evidence"], ["[]", "invalid-evidence"],
      [JSON.stringify({ ...value, rawError: "PRIVATE_SQL_PASSWORD" }), "invalid-evidence"],
      [Buffer.alloc(16385), "invalid-file"], [JSON.stringify(value), "valid"]]) {
      await writeFile(path, bytes, { mode: 0o600 })
      const result = await readRecoveryHostOutcome(path)
      assert.equal(result.status, expected)
      assert.deepEqual(result.host, expected === "valid" ? value : null)
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SQL_PASSWORD/)
    }
    await rm(path); await mkdir(path)
    assert.deepEqual(await readRecoveryHostOutcome(path), { status: "invalid-file", host: null })
    await rm(path, { recursive: true }); await writeFile(join(root, "private-target"), JSON.stringify(value), { mode: 0o600 })
    await symlink(join(root, "private-target"), path)
    assert.deepEqual(await readRecoveryHostOutcome(path), { status: "invalid-file", host: null })
    for (const code of ["EACCES", "EPERM", "EIO", "PRIVATE_SQL_PASSWORD"]) {
      const result = await readRecoveryHostOutcome(path, { openFile: async () => { throw Object.assign(new Error("PRIVATE_SQL_PASSWORD"), { code }) } })
      assert.deepEqual(result, { status: "read-error", host: null })
    }
    for (const failedPhase of ["stat", "read", "close"]) {
      let closed = false
      const fakeFile = {
        stat: async () => { if (failedPhase === "stat") throw Error("PRIVATE_SQL_PASSWORD"); return { isFile: () => true, size: 0 } },
        read: async () => { if (failedPhase === "read") throw Error("PRIVATE_SQL_PASSWORD"); return { bytesRead: 0 } },
        close: async () => { closed = true; if (failedPhase === "close") throw Error("PRIVATE_SQL_PASSWORD") },
      }
      assert.deepEqual(await readRecoveryHostOutcome(path, { openFile: async () => fakeFile }), { status: "read-error", host: null })
      assert.equal(closed, true)
    }
    // Check the bound again after opening: a file can grow after stat.
    let bounded = false
    assert.deepEqual(await readRecoveryHostOutcome(path, { openFile: async () => ({
      stat: async () => ({ isFile: () => true, size: 1 }),
      read: async (buffer, offset, length) => { assert.equal(buffer.length, 16385); bounded = true; return { bytesRead: length } },
      close: async () => {},
    }) }), { status: "invalid-file", host: null })
    assert.equal(bounded, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("invalid host preflight preserves independently valid native diagnostic and remains failure-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "fcuno-host-preflight-"))
  const pubRuntime = { ...runtime, FCUNO_RECOVERY_SOURCE_COMMIT: "f".repeat(40), POSTGRES_BACKUP_VERIFICATION_KEY_PEM: publicPem }
  const plan = { buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, sourceCommit: pubRuntime.FCUNO_RECOVERY_SOURCE_COMMIT,
    manifest: manifestReceipt, verificationKeySha256: sha(Buffer.from(publicPem)) }
  const trace = createRecoveryDiagnostics({ now }); await trace.stage("verify-catalog"); await trace.failed(); await trace.cleanup("ok")
  try {
    await mkdir(join(root, "input")); await mkdir(join(root, "output"))
    await writeFile(join(root, "plan.json"), JSON.stringify(plan), { mode: 0o600 })
    await writeFile(join(root, "input/manifest.json"), manifestBytes, { mode: 0o600 })
    await writeFile(join(root, "output/diagnostic.json"), JSON.stringify(trace.snapshot()), { mode: 0o600 })
    for (const [bytes, expected] of [["{PRIVATE_SQL_PASSWORD", "invalid-json"], ["null", "invalid-evidence"], [Buffer.alloc(16385), "invalid-file"]]) {
      await writeFile(join(root, "host-outcome.json"), bytes, { mode: 0o600 })
      const result = await readRecoveryPublicationInputs({ workspace: root, runtime: pubRuntime, descriptor: manifestReceipt, publicKey })
      assert.equal(result.hostReadStatus, expected); assert.equal(result.hostOutcome, null)
      assert.deepEqual(result.diagnostic, trace.snapshot()); assert.equal(recoveryPublicationFailed(result), true)
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SQL_PASSWORD/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("every invalid host status creates only a verified failure receipt and can never authorize acceptance", async () => {
  const trace = createRecoveryDiagnostics({ now }); await trace.cleanup("ok"); await trace.complete()
  const diagnostic = trace.snapshot()
  const successfulHost = { schema: "fcuno.private-recovery-host-outcome/v1", dockerRunExitCode: 0,
    state: { Status: "exited", Running: false, ExitCode: 0, OOMKilled: false } }
  const plan = { manifest: manifestReceipt, buildId: runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID, sourceCommit: "f".repeat(40) }
  // Valid success takes exactly the original success predicate; any invalid
  // host status still fails even if the native diagnostic claims completion.
  assert.equal(recoveryPublicationFailed({ hostOutcome: successfulHost, hostReadStatus: "valid", diagnostic }), false)
  for (const hostReadStatus of ["missing", "invalid-file", "invalid-json", "invalid-evidence", "read-error"]) {
    let recorded, receipt, writes = 0, acceptanceWrites = 0
    const stages = createRecoveryControllerStages()
    const gcs = {
      uploadImmutable: async () => { acceptanceWrites++; throw Error("acceptance forbidden") },
      uploadRecoveryFailure: async input => { writes++; recorded = input.bytes
        receipt = { target: { ...manifestReceipt.target, objectName: manifestReceipt.target.objectName.replace("manifest.json", `failures/${plan.buildId}.json`), generation: "123" },
          sizeBytes: recorded.length, crc32c: crc(recorded) }; return receipt },
      readTarget: async () => ({ ...receipt, bytes: (async function* () { yield recorded })() }),
      inspectTarget: async () => receipt,
    }
    await assert.rejects(recordRecoveryFailureAndReject({ gcs, context: context(), plan, host: null, hostReadStatus, diagnostic, stage: stages.enter }))
    assert.equal(stages.exitCode(), 46); assert.equal(writes, 1); assert.equal(acceptanceWrites, 0)
    const report = JSON.parse(recorded)
    assert.equal(report.hostReadStatus, hostReadStatus); assert.equal(report.host, null)
    assert.deepEqual(report.diagnostic, diagnostic); assert.equal(report.recoveryVerified, false)
    assert.throws(() => validateRecoveryAcceptanceDescriptor({ ...receipt, byteSha256: sha(recorded) }))
    assert.throws(() => recoveryPublicationFailed({ hostOutcome: successfulHost, hostReadStatus, diagnostic }))
  }
  for (const hostReadStatus of [undefined, null, "__proto__", "constructor", 0, "PRIVATE_SQL_PASSWORD", {}])
    assert.throws(() => recoveryPublicationFailed({ hostOutcome: null, hostReadStatus, diagnostic }))
  assert.throws(() => recoveryPublicationFailed({ hostOutcome: null, hostReadStatus: "valid", diagnostic }))
  let writes = 0
  await assert.rejects(recordRecoveryFailureAndReject({ gcs: { uploadRecoveryFailure: async () => { writes++ } }, context: context(),
    plan, host: successfulHost, hostReadStatus: "valid", diagnostic }))
  assert.equal(writes, 0, "the failure writer must not relabel real success or publish any acceptance")
  const source = await readFile(new URL("../scripts/postgres-recovery/cloud.mjs", import.meta.url), "utf8")
  assert.match(source, /if \(recoveryPublicationFailed\(\{ hostOutcome, hostReadStatus, diagnostic \}\)\)\s+await recordRecoveryFailureAndReject/)
})

test("failure publisher exposes only fixed substages and never a success exit", async () => {
  const buildId = runtime.FCUNO_POSTGRES_RECOVERY_BUILD_ID
  const host = { schema: "fcuno.private-recovery-host-outcome/v1", dockerRunExitCode: 1,
    state: { Status: "exited", Running: false, ExitCode: 1, OOMKilled: false } }
  for (const [fault, code] of [["input", 40], ["upload", 41], ["receipt", 42], ["readback", 43], ["bytes", 44], ["inspect", 45], ["none", 46]]) {
    const trace = createRecoveryControllerStages(); let bytes, receipt, acceptanceWrites = 0
    const privateError = Object.assign(new Error("private SQL password token"), { exitCode: 0, code: 0 })
    const gcs = {
      uploadImmutable: async () => { acceptanceWrites++; throw privateError },
      uploadRecoveryFailure: async input => {
        if (fault === "upload") throw privateError
        bytes = input.bytes; receipt = { target: { ...manifestReceipt.target,
          objectName: manifestReceipt.target.objectName.replace("manifest.json", `failures/${buildId}.json`), generation: "123" }, sizeBytes: bytes.length, crc32c: crc(bytes) }
        return fault === "receipt" ? { ...receipt, sizeBytes: bytes.length + 1 } : receipt
      },
      readTarget: async () => {
        if (fault === "readback") throw privateError
        return { ...receipt, bytes: (async function* () { yield fault === "bytes" ? Buffer.alloc(bytes.length) : bytes })() }
      },
      inspectTarget: async () => { if (fault === "inspect") throw privateError; return receipt },
    }
    await assert.rejects(recordRecoveryFailureAndReject({ gcs, context: context(), plan: { manifest: manifestReceipt,
      buildId: fault === "input" ? "invalid" : buildId, sourceCommit: "f".repeat(40) }, host, diagnostic: null, stage: trace.enter }))
    assert.equal(trace.exitCode(), code); assert.equal(acceptanceWrites, 0)
    if (bytes) { assert.equal(JSON.parse(bytes).diagnostic, null); assert.ok(!bytes.includes(Buffer.from("private SQL password token"))) }
  }
})

test("actual controller CLI returns numeric stage without printing injected private input", async () => {
  const run = promisify(execFile), script = new URL("../scripts/postgres-recovery/cloud.mjs", import.meta.url)
  const privateInput = "private SQL password token"
  await assert.rejects(run(process.execPath, ["--no-warnings", script.pathname, privateInput], { env: { PATH: process.env.PATH || "" } }), error => {
    assert.equal(error.code, 20); assert.equal(error.stdout, ""); assert.equal(error.stderr, ""); return true
  })
  await assert.rejects(run(process.execPath, ["--no-warnings", script.pathname, "publish"], { env: { PATH: process.env.PATH || "" } }), error => {
    assert.equal(error.code, 21); assert.equal(error.stdout, ""); assert.equal(error.stderr, ""); return true
  })
})

test("diagnostics source closure is explicit and no raw error output was enabled", async () => {
  const source = await readFile(new URL("../scripts/postgres-recovery/offline.mjs", import.meta.url), "utf8")
  assert.match(source, /stderr\.on\("data", \(\) => \{\}\)/)
  assert.match(source, /process\.stderr\.on\("data", stderrHint\.write\)/)
  assert.match(source, /diagnostics\.native\(name, code, signal, stderrHint\.value\(\)\)/)
  assert.doesNotMatch(source, /console\.(?:log|error)|\.stack|stderr\.pipe/)
  for (const [path, pattern] of [["../.gcloudignore", /!lib\/postgresRecoveryDiagnostics\.mjs/],
    ["../scripts/postgres-recovery/Dockerfile.dockerignore", /!lib\/postgresRecoveryDiagnostics\.mjs/],
    ["../scripts/postgres-recovery/Dockerfile", /COPY lib\/postgresBackupReceipt\.mjs[^\n]*lib\/postgresRecoveryDiagnostics\.mjs/],
    ["../.gcloudignore", /!lib\/postgresRecoveryColumns\.mjs/],
    ["../scripts/postgres-recovery/Dockerfile.dockerignore", /!lib\/postgresRecoveryColumns\.mjs/],
    ["../scripts/postgres-recovery/Dockerfile", /COPY lib\/postgresBackupReceipt\.mjs[^\n]*lib\/postgresRecoveryColumns\.mjs/],
    ["../.gcloudignore", /!lib\/postgresRecoveryAcl\.mjs/],
    ["../scripts/postgres-recovery/Dockerfile.dockerignore", /!lib\/postgresRecoveryAcl\.mjs/],
    ["../scripts/postgres-recovery/Dockerfile", /COPY lib\/postgresBackupReceipt\.mjs[^\n]*lib\/postgresRecoveryAcl\.mjs/]])
    assert.match(await readFile(new URL(path, import.meta.url), "utf8"), pattern)
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
  for (const maintenance of [undefined, JSON.stringify({ schema: "fcuno.recovery-maintenance-attestation/v1", checkedAt: new Date(now()).toISOString() })]) {
    await assert.rejects(backupMain({ args: ["--execute-recurring-weekly"], runtime: {
      CLOUD_RUN_JOB: pins.storageMediaBackup.googleJob, POSTGRES_BACKUP_RECURRING_ENABLED: "1", POSTGRES_BACKUP_VERIFICATION_KEY_PEM: publicPem,
      POSTGRES_BACKUP_RECOVERY_MAINTENANCE_JSON: maintenance,
    }, fetch: async () => { calls++; throw Error("must not fetch") } }), /acceptance remains pending/)
  }
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
