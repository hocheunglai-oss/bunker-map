import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { transformSync } from "esbuild"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { createMetadataAccessTokenProvider, createExistingDriveAccessTokenProvider, requireStorageMediaJobRuntime } from "../scripts/lib/storage-media-job-auth.mjs"
import { main } from "../scripts/backup-storage-media-to-gcs.mjs"

const policy = fcunoConnectionPolicy.storageMediaBackup
const runtime = { CLOUD_RUN_JOB: policy.googleJob, GOOGLE_CLOUD_PROJECT: policy.googleProjectId, GCS_BACKUP_BUCKET: policy.targetBucket,
  GOOGLE_OAUTH_CLIENT_ID: "test-client", GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret", GOOGLE_DRIVE_REFRESH_TOKEN: "test-existing-refresh" }
const context = () => ({ signal: new AbortController().signal, deadline: Date.now() + 60_000 })
const token = () => ({ access_token: "test-access-token", token_type: "Bearer", expires_in: 3600 })

test("job auth denies wrong execution/project/bucket and permanent key fallback before IO", async () => {
  for (const change of [{ CLOUD_RUN_JOB: "other" }, { GOOGLE_CLOUD_PROJECT: "other" }, { GCP_PROJECT_ID: "other" },
    { GCS_BACKUP_BUCKET: "other" }, { GOOGLE_APPLICATION_CREDENTIALS: "/key.json" }, { GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private" }]) {
    assert.throws(() => requireStorageMediaJobRuntime({ ...runtime, ...change }))
    let calls = 0
    const get = createMetadataAccessTokenProvider({ runtime: { ...runtime, ...change }, fetch: async () => { calls++; throw Error("must not fetch") } })
    await assert.rejects(get(context())); assert.equal(calls, 0)
  }
})

test("ADC checks exact job service account then uses only metadata token with bounded caching", async () => {
  let time = Date.now(), calls = 0
  const get = createMetadataAccessTokenProvider({ runtime, now: () => time, fetch: async (url, init) => {
    calls++; const parsed = new URL(url)
    assert.equal(parsed.origin, "http://metadata.google.internal"); assert.equal(init.headers["Metadata-Flavor"], "Google")
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.ok(init.signal instanceof AbortSignal)
    return parsed.pathname.endsWith("/email") ? new Response(policy.googleServiceAccount, { headers: { "Metadata-Flavor": "Google" } }) :
      Response.json(token(), { headers: { "Metadata-Flavor": "Google" } })
  } })
  assert.equal(await get(context()), "test-access-token"); assert.equal(await get(context()), "test-access-token"); assert.equal(calls, 2)
  time += 3_550_000
  assert.equal(await get(context()), "test-access-token"); assert.equal(calls, 4)
})

test("wrong metadata account or flavor is denied before access token retrieval", async () => {
  for (const [email, flavor] of [["other@example.com", "Google"], [policy.googleServiceAccount, "Other"]]) {
    let calls = 0
    const get = createMetadataAccessTokenProvider({ runtime, fetch: async () => { calls++; return new Response(email, { headers: { "Metadata-Flavor": flavor } }) } })
    await assert.rejects(get(context())); assert.equal(calls, 1)
  }
})

test("Drive refresh reuses only existing env credentials at fixed OAuth endpoint and never persists replacement refresh tokens", async () => {
  let calls = 0
  const get = createExistingDriveAccessTokenProvider({ runtime, fetch: async (url, init) => {
    calls++; assert.equal(url, "https://oauth2.googleapis.com/token"); assert.equal(init.method, "POST")
    assert.equal(init.redirect, "error"); assert.equal(init.body.get("grant_type"), "refresh_token")
    assert.equal(init.body.get("client_id"), "test-client"); assert.equal(init.body.get("client_secret"), "test-client-secret")
    assert.equal(init.body.get("refresh_token"), "test-existing-refresh")
    return Response.json({ ...token(), refresh_token: "must-not-adopt" })
  } })
  assert.equal(await get(context()), "test-access-token"); assert.equal(await get(context()), "test-access-token")
  assert.equal(calls, 1); assert.equal(runtime.GOOGLE_DRIVE_REFRESH_TOKEN, "test-existing-refresh")
})

test("invalid/missing/oversized token responses and errors are sanitized", async () => {
  for (const response of [Response.json({ ...token(), access_token: "token with whitespace" }), Response.json({ ...token(), expires_in: 7200 }),
    Response.json({ ...token(), expires_in: 0 }), Response.json({ error: "test-client-secret" }, { status: 401 }), new Response("x".repeat(20_000))]) {
    const get = createExistingDriveAccessTokenProvider({ runtime, fetch: async () => response })
    await assert.rejects(get(context()), error => !String(error.message).includes("test-client-secret"))
  }
  let calls = 0
  const get = createExistingDriveAccessTokenProvider({ runtime: { ...runtime, GOOGLE_DRIVE_REFRESH_TOKEN: "" }, fetch: async () => { calls++; throw Error("unused") } })
  await assert.rejects(get(context())); assert.equal(calls, 0)
})

test("aborted and expired token operations never fetch", async () => {
  let calls = 0
  const get = createMetadataAccessTokenProvider({ runtime, fetch: async () => { calls++; throw Error("unused") } })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(get({ signal: controller.signal, deadline: Date.now() + 1000 }))
  await assert.rejects(get({ signal: new AbortController().signal, deadline: Date.now() - 1 })); assert.equal(calls, 0)
})

test("one-time CLI denies missing execution confirmation or local runtime without network", async () => {
  let calls = 0
  const fetch = async () => { calls++; throw Error("must not fetch") }
  for (const args of [[], ["--execute-approved-snapshot", "extra"], ["--other"]]) await assert.rejects(main({ args, runtime, fetch }))
  await assert.rejects(main({ args: ["--execute-approved-snapshot"], runtime: {}, fetch })); assert.equal(calls, 0)
})

test("CLI failure output is constant and never prints the thrown exception message", () => {
  const result = spawnSync(process.execPath, ["scripts/backup-storage-media-to-gcs.mjs", "--not-authorized"], { cwd: process.cwd(), encoding: "utf8" })
  assert.equal(result.status, 1); assert.equal(result.stdout, "")
  assert.match(result.stderr, /Storage media backup failed\. Inspect the private backup control record before retrying\./)
  assert.doesNotMatch(result.stderr, /Explicit one-time|Error:|client_secret|refresh_token/)
})

function dockerCopySources(docker) {
  const sources = new Set()
  for (const line of docker.split("\n").filter(line => line.startsWith("COPY "))) {
    for (const source of line.trim().split(/\s+/).slice(1, -1)) {
      assert.doesNotMatch(source, /^--|\[|\?|\*\*/)
      if (!source.includes("*")) {
        readFileSync(new URL(`../${source}`, import.meta.url))
        sources.add(source)
        continue
      }
      const slash = source.lastIndexOf("/")
      const directory = source.slice(0, slash + 1)
      const pattern = new RegExp(`^${source.slice(slash + 1).split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
      const matches = readdirSync(new URL(`../${directory}`, import.meta.url), { withFileTypes: true })
        .filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => directory + entry.name)
      assert.ok(matches.length > 0, `Docker COPY wildcard has no files: ${source}`)
      for (const match of matches) sources.add(match)
    }
  }
  return sources
}

test("image packaging preserves Drive default and the complete one-time and recurring import closure", () => {
  const docker = readFileSync(new URL("../Dockerfile.drive-backup", import.meta.url), "utf8")
  assert.match(docker, /CMD \["npm", "run", "backup:drive-files:gcs"\]/)
  const copied = dockerCopySources(docker)
  for (const required of ["scripts/backup-google-drive-files-to-gcs.mjs", "scripts/backup-storage-media-to-gcs.mjs",
    "scripts/lib/storage-media-recurring-run.mjs", "scripts/lib/storage-media-drive-publication.mjs", "scripts/lib/storage-media-budget-runtime.mjs",
    "scripts/lib/backup-budget-guard.mjs", "scripts/lib/backup-budget-pubsub.mjs", "config/fcunoConnections.ts",
    "lib/storageMediaBackup.mjs", "lib/storageMediaRecurring.mjs", "lib/storageMediaBackupHealth.mjs", "lib/backupOperatingPolicy.mjs", "lib/backupValidationSpool.mjs"]) assert.ok(copied.has(required), required)
  const { dependencies } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  for (const file of copied) {
    if (!/\.(?:mjs|ts)$/.test(file)) continue
    const code = transformSync(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), { loader: file.endsWith(".ts") ? "ts" : "js", format: "esm", target: "node24" }).code
    for (const [, , specifier] of code.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)(["'])([^"']+)\1/g)) {
      if (specifier.startsWith("node:")) continue
      if (specifier.startsWith(".")) {
        const dependency = posix.normalize(posix.join(posix.dirname(file), specifier))
        assert.ok(copied.has(dependency), `Docker import missing: ${file} -> ${dependency}`)
      } else {
        const dependency = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
        assert.ok(Object.hasOwn(dependencies, dependency), `Production package missing: ${file} -> ${dependency}`)
      }
    }
  }
  assert.doesNotMatch(docker, /ENV STORAGE_MEDIA_BACKUP_|GOOGLE_APPLICATION_CREDENTIALS|\.env|oauth-token/)
})

test("Cloud Build upload allowlist includes every Docker COPY source and excludes local private files", () => {
  const docker = readFileSync(new URL("../Dockerfile.drive-backup", import.meta.url), "utf8")
  const ignore = readFileSync(new URL("../.gcloudignore", import.meta.url), "utf8")
  // This file uses ordinary gitignore syntax only. Keep the offline check honest
  // if a future change introduces gcloud's include directive.
  assert.doesNotMatch(ignore, /^#!include:/m)
  const sources = new Set(["cloudbuild.drive-backup.yaml", "Dockerfile.drive-backup", ...dockerCopySources(docker)])
  const denied = [".env", ".env.local", ".git/config", ".google-drive-oauth-token.json", ".vercel/project.json",
    "browser-state/session.json", "backups/database.json", "exports/database.sql", "node_modules/package/index.js",
    "scripts/auth-google-drive.mjs", "scripts/lib/private-key.json", "scripts/lib/storage-media-token.json",
    "config/private-key.json", "lib/credentials.mjs", "app/page.tsx", "tests/storage-media-job-auth.test.mjs"]
  const fixture = mkdtempSync(join(tmpdir(), "fcuno-gcloudignore-test-"))
  try {
    const initialized = spawnSync("git", ["init", "--quiet", "--template=", fixture], { encoding: "utf8" })
    assert.equal(initialized.status, 0, initialized.stderr)
    writeFileSync(join(fixture, ".gitignore"), ignore)
    const checked = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"], {
      cwd: fixture, input: [...sources, ...denied].join("\n") + "\n", encoding: "utf8",
    })
    assert.equal(checked.status, 0, checked.stderr)
    assert.deepEqual(checked.stdout.trim().split("\n").sort(), [...denied].sort())
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
