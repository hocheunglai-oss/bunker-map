import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
}

const consumers = [
  source("app/api/backups/bunker-map-drive/route.ts"),
  source("lib/systemHealth.ts"),
  source("scripts/validate-backup.mjs"),
]

function extractTables(content: string, start: RegExp, end: RegExp) {
  const startMatch = start.exec(content)
  assert.ok(startMatch, `Missing table-list start ${start}`)
  const remainder = content.slice(startMatch.index + startMatch[0].length)
  const endMatch = end.exec(remainder)
  assert.ok(endMatch, `Missing table-list end ${end}`)
  return [...remainder.slice(0, endMatch.index).matchAll(/table: "([a-z0-9_]+)"/g)]
    .map((match) => match[1])
    .sort()
}

function extractStringArray(content: string, name: string) {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(content)
  assert.ok(match, `Missing string array ${name}`)
  return [...match[1].matchAll(/"([a-z0-9_]+)"/g)]
    .map((item) => item[1])
    .sort()
}

test("all backup consumers register the same durable tables", () => {
  const routeTables = extractTables(
    consumers[0],
    /const TABLES[^=]*= \[/,
    /const TRUTH_MANAGED_TABLES/
  )
  const healthTables = extractTables(
    consumers[1],
    /const BACKUP_TABLE_SECTIONS = \[/,
    /const BACKUP_TRUTH_SECTIONS/
  )
  const validatorTables = extractTables(
    consumers[2],
    /const TABLE_SECTIONS = \[/,
    /const TRUTH_SECTIONS/
  )

  assert.deepEqual(healthTables, routeTables)
  assert.deepEqual(validatorTables, routeTables)
})

test("durable FCUNO identity state is exported by every backup contract consumer", () => {
  for (const consumer of consumers) {
    assert.match(
      consumer,
      /FCUNO_IDENTITY_FEDERATION_MIGRATION_HEAD = "20260830182946"/
    )
    for (const table of [
      "fcuno_identity_audit",
      "fcuno_identity_sync_outbox",
      "spc_identity_links",
    ]) {
      assert.match(
        consumer,
        new RegExp(
          `table: "${table}",[\\s\\S]{0,250}?introducedAt: FCUNO_IDENTITY_FEDERATION_MIGRATION_HEAD`
        )
      )
    }
  }
})

test("short-lived OIDC state is explicitly ephemeral in every consumer", () => {
  for (const consumer of consumers) {
    assert.match(
      consumer,
      /FCUNO_IDENTITY_EPHEMERAL_TABLES = \[\s*"oidc_authorization_codes",\s*"oidc_token_revocations",\s*\]/
    )
    assert.match(
      consumer,
      /migrationHead >= FCUNO_IDENTITY_FEDERATION_MIGRATION_HEAD[\s\S]*?FCUNO_IDENTITY_EPHEMERAL_TABLES/
    )
  }

  const baseNames = [
    "BASE_EXPLICITLY_EPHEMERAL_TABLES",
    "BACKUP_BASE_EPHEMERAL_TABLES",
    "BASE_EXPLICITLY_EPHEMERAL_TABLES",
  ]
  const baseEphemeralTables = consumers.map((consumer, index) =>
    extractStringArray(consumer, baseNames[index])
  )
  assert.deepEqual(baseEphemeralTables[1], baseEphemeralTables[0])
  assert.deepEqual(baseEphemeralTables[2], baseEphemeralTables[0])

  assert.doesNotMatch(
    consumers[0],
    /key: "oidcAuthorizationCodes"|key: "oidcTokenRevocations"/
  )
})

test("durable identity tables participate in the backup mutation epoch", () => {
  const migration = source(
    "supabase/migrations/20260901022137_fence_fcuno_identity_backup_tables.sql"
  )

  for (const table of [
    "fcuno_identity_audit",
    "fcuno_identity_sync_outbox",
    "spc_identity_links",
  ]) {
    assert.match(migration, new RegExp(`to_regclass\\('public\\.${table}'\\)`))
    assert.match(
      migration,
      new RegExp(
        `create trigger bunker_map_backup_epoch_fence[\\s\\S]*?on public\\.${table}[\\s\\S]*?private\\.record_bunker_map_backup_mutation\\(\\)`
      )
    )
  }

  assert.doesNotMatch(migration, /oidc_authorization_codes|oidc_token_revocations/)
})
