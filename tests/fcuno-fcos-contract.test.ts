import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

const contractDirectory = join(process.cwd(), "contracts", "fcuno-fcos", "v1")
const fixtureDirectory = join(process.cwd(), "fixtures", "fcuno-fcos", "v1")

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

test("the immutable contract manifest covers every v1 schema", async () => {
  const manifest = JSON.parse(
    await readFile(join(contractDirectory, "contract-manifest.json"), "utf8"),
  ) as {
    contractVersion: string
    aggregateSha256: string
    files: Array<{ path: string; sha256: string }>
  }
  const schemaFiles = (await readdir(contractDirectory))
    .filter((file) => file.endsWith(".schema.json"))
    .sort()
  const aggregate = createHash("sha256")

  assert.equal(manifest.contractVersion, "1.0")
  assert.deepEqual(
    manifest.files.map(({ path }) => path),
    schemaFiles,
  )
  for (const file of schemaFiles) {
    const bytes = await readFile(join(contractDirectory, file))
    const expected = manifest.files.find(({ path }) => path === file)
    assert.equal(sha256(bytes), expected?.sha256)
    assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")))
    aggregate.update(file)
    aggregate.update(Buffer.from([0]))
    aggregate.update(bytes)
    aggregate.update(Buffer.from([0]))
  }
  assert.equal(aggregate.digest("hex"), manifest.aggregateSha256)
})

test("identity fixtures use exact stable subjects and monotonic revisions", async () => {
  const active = JSON.parse(
    await readFile(join(fixtureDirectory, "identity-active.json"), "utf8"),
  )
  const revoked = JSON.parse(
    await readFile(join(fixtureDirectory, "identity-revoked.json"), "utf8"),
  )

  assert.equal(active.event_type, "fcuno.identity.v1")
  assert.equal(revoked.event_type, "fcuno.identity.v1")
  assert.equal(active.typ, "fcuno.identity-sync+jwt")
  assert.equal(revoked.typ, "fcuno.identity-sync+jwt")
  assert.equal(active.aud, "fcos-identity-sync")
  assert.equal(revoked.aud, "fcos-identity-sync")
  assert.equal(active.jti, active.event_id)
  assert.equal(revoked.jti, revoked.event_id)
  assert.equal(active.sub, active.identity.sub)
  assert.equal(revoked.sub, revoked.identity.sub)
  assert.equal(active.exp - active.iat, 300)
  assert.equal(revoked.exp - revoked.iat, 300)
  assert.equal(active.identity.sub, revoked.identity.sub)
  assert.equal(active.identity.email, active.identity.email.toLowerCase())
  assert.equal(active.identity.email_verified, true)
  assert.equal(revoked.identity.email_verified, true)
  assert.equal(active.identity.use_fcos, true)
  assert.equal(revoked.identity.use_fcos, false)
  assert.ok(revoked.identity.identity_revision > active.identity.identity_revision)
  assert.ok(Date.parse(revoked.identity.revoked_before) > Date.parse(active.identity.revoked_before))
})
