import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import ts from "typescript"

// Execute the actual narrow function; no route import, credentials, provider
// client, artifact bytes, network request or retention operation is involved.
const source = readFileSync(new URL("../app/api/backups/bunker-map-drive/route.ts", import.meta.url), "utf8")
const tree = ts.createSourceFile("backup-route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "markBackupVerified")
assert.ok(fn)
const constant = name => {
  const declaration = tree.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(tree) === name)
  assert.ok(declaration?.initializer && ts.isStringLiteral(declaration.initializer), name)
  return declaration.initializer.text
}
const code = ts.transpileModule(fn.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const markBackupVerified = new Function("BACKUP_FILE_SCHEMA", "BACKUP_STREAM_VERIFICATION_SCHEMA", `${code}; return markBackupVerified;`)(constant("BACKUP_FILE_SCHEMA"), constant("BACKUP_STREAM_VERIFICATION_SCHEMA"))
const prepared = { artifactPrefix: { deploymentCommit: "synthetic-commit", backupRunId: "synthetic-run", source: "admin-manual" },
  truthHeadSequence: 7, truthHeadSha256: "a".repeat(64), migrationHead: "20261022092121", pricingSchemaVersion: "synthetic-pricing", attendanceSchemaVersion: "annual-v1", databaseEpoch: 4,
  inventorySha256: "b".repeat(64), catalogSha256: "c".repeat(64), liveTableCount: 12, sectionCount: 15, totalRecordCount: 27,
  generatedAt: "2026-10-22T01:02:03.000Z", latestCertificationRunId: "synthetic-certification", latestProjectionSnapshotSha256: "d".repeat(64) }
const streamed = { artifactSha256: "e".repeat(64), uploadedFileSha256: "f".repeat(64), fileByteLength: 12345 }
const previous = { fileId: "synthetic-previous", name: "synthetic-previous.json", createdTime: "2026-10-21T01:02:03.000Z", artifactSha256: "1".repeat(64), uploadedFileSha256: "2".repeat(64) }
async function run(prior = previous) {
  const calls = [], acknowledgement = { id: "synthetic-new-backup", name: "synthetic.json" }
  const drive = { files: { async update(input) { calls.push(input); return { data: acknowledgement } } } }
  const result = await markBackupVerified(drive, acknowledgement.id, prepared, streamed, prior)
  assert.equal(result, acknowledgement); assert.equal(calls.length, 1)
  return calls[0]
}

test("actual backup description distinguishes upload MD5/size receipt from later stored-byte SHA verification", async () => {
  const { requestBody } = await run()
  assert.match(requestBody.description, /Drive confirmed the upload MD5 checksum and byte length/)
  assert.match(requestBody.description, /Stored-byte SHA-256 verification is a separate System Health check/)
  assert.doesNotMatch(requestBody.description, /stream-downloaded|bytes were.*SHA-256 checked/)
})

test("description correction preserves every backup receipt property, predecessor anchor and Drive update argument", async () => {
  for (const prior of [previous, null]) {
    const input = await run(prior)
    assert.deepEqual({ ...input, requestBody: { ...input.requestBody, description: "COPY ONLY" } }, {
      fileId: "synthetic-new-backup", supportsAllDrives: true, fields: "id,name,webViewLink,createdTime,mimeType,appProperties",
      requestBody: { description: "COPY ONLY", appProperties: {
        backupSchema: constant("BACKUP_FILE_SCHEMA"), verificationContract: constant("BACKUP_STREAM_VERIFICATION_SCHEMA"), verificationStatus: "complete",
        artifactSha256: streamed.artifactSha256, uploadedFileSha256: streamed.uploadedFileSha256, fileByteLength: "12345",
        truthHeadSequence: "7", truthHeadSha256: prepared.truthHeadSha256, migrationHead: prepared.migrationHead, pricingSchemaVersion: prepared.pricingSchemaVersion,
        attendanceSchemaVersion: prepared.attendanceSchemaVersion,
        databaseEpoch: "4", inventorySha256: prepared.inventorySha256, catalogSha256: prepared.catalogSha256, liveTableCount: "12", sectionCount: "15", totalRecordCount: "27",
        backupRunId: "synthetic-run", generatedAt: prepared.generatedAt, deploymentCommit: "synthetic-commit", source: "admin-manual",
        latestCertificationRunId: prepared.latestCertificationRunId, latestProjectionSnapshotSha256: prepared.latestProjectionSnapshotSha256,
        previousFileId: prior?.fileId || "none", previousFileName: prior?.name || "none", previousCreatedTime: prior?.createdTime || "none",
        previousArtifactSha256: prior?.artifactSha256 || "none", previousUploadedFileSha256: prior?.uploadedFileSha256 || "none",
      } },
    })
  }
})

test("a failed metadata update still propagates unchanged, without manufacturing a verified acknowledgement", async () => {
  const failure = new Error("Synthetic metadata update failure")
  let calls = 0
  await assert.rejects(markBackupVerified({ files: { async update() { calls++; throw failure } } }, "synthetic", prepared, streamed, previous), error => error === failure)
  assert.equal(calls, 1)
})
