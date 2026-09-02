import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import test from "node:test"

const files = {
  worker: new URL(
    "../scripts/azure-automation/sync-fcuno-outlook-addressbook.ps1",
    import.meta.url,
  ),
  recipientMap: new URL(
    "../app/api/outlook-addin/recipient-map/route.ts",
    import.meta.url,
  ),
  resolver: new URL(
    "../lib/outlookTemplateRecipientResolver.ts",
    import.meta.url,
  ),
  backupValidator: new URL("../scripts/validate-backup.mjs", import.meta.url),
  systemHealth: new URL("../lib/systemHealth.ts", import.meta.url),
}

async function sources() {
  const values = await Promise.all(
    Object.values(files).map((file) => readFile(file, "utf8")),
  )
  const result = Object.fromEntries(
    Object.keys(files).map((name, index) => [name, values[index]]),
  ) as Record<keyof typeof files, string> & {
    migration: string
    historicalSnapshotMigration: string
  }
  const migrationsDirectory = new URL("../supabase/migrations/", import.meta.url)
  const migrationNames = await readdir(migrationsDirectory)
  const migrationName = migrationNames.find((name) =>
    name.endsWith("_certify_outlook_group_smtp_truth.sql"),
  )
  const historicalSnapshotMigrationName = migrationNames.find((name) =>
    name.endsWith(
      "_restore_historical_outlook_exchange_snapshot_validation.sql",
    ),
  )
  assert.ok(migrationName, "group SMTP truth migration should exist")
  assert.ok(
    historicalSnapshotMigrationName,
    "historical snapshot validation migration should exist",
  )
  result.migration = await readFile(new URL(migrationName, migrationsDirectory), "utf8")
  result.historicalSnapshotMigration = await readFile(
    new URL(historicalSnapshotMigrationName, migrationsDirectory),
    "utf8",
  )
  return result
}

test("group SMTP identity is projected, written, and certified exactly", async () => {
  const { worker } = await sources()

  assert.match(worker, /Get-AutomationSetting "EXCHANGE_ADDRESSBOOK_DOMAIN"/)
  assert.match(worker, /smtpAddress = Normalize-Email \$_\.SmtpAddress/)
  assert.match(worker, /-PrimarySmtpAddress \$smtpAddress/)
  assert.match(
    worker,
    /\$smtpAddress = Get-ExpectedExchangeGroupSmtpAddress \$Group/,
  )
  assert.match(
    worker,
    /\(Normalize-Email \$Existing\.PrimarySmtpAddress\) -cne \$expectedSmtpAddress/,
  )
  assert.match(worker, /\$mismatches \+= "primary SMTP address"/)
})

test("all Outlook and backup consumers require projection-exact group SMTP truth", async () => {
  const source = await sources()

  assert.match(source.recipientMap, /cleanText\(group\.smtpAddress\)/)
  assert.match(source.resolver, /cleanProjectedEmail\(group\.smtpAddress\)/)
  for (const consumer of [source.recipientMap, source.resolver]) {
    assert.doesNotMatch(consumer, /OUTLOOK_ADDIN_GROUP_DOMAIN/)
    assert.doesNotMatch(consumer, /DEFAULT_GROUP_SMTP_DOMAIN/)
    assert.doesNotMatch(consumer, /cosulich1\.onmicrosoft\.com/)
  }
  assert.match(
    source.backupValidator,
    /ref\.resolvedAddress !== candidate\.address/,
  )
  assert.match(
    source.systemHealth,
    /resolvedAddress !== candidate\.address/,
  )
  assert.doesNotMatch(
    source.backupValidator,
    /group address does not match its projection alias/,
  )
  assert.doesNotMatch(
    source.systemHealth,
    /group address does not match its projection alias/,
  )
})

test("database reconciliation uses smtpAddress with no alias-domain fallback", async () => {
  const { migration } = await sources()

  assert.match(migration, /candidate ->> 'smtpAddress'/)
  assert.match(migration, /'resolvedAddress', null,[\s\S]*'status', 'missing'/)
  assert.match(
    migration,
    /not \(p_ref \? 'kind'\)[\s\S]*recipient_kind is null[\s\S]*recipient_kind not in \('contact', 'group'\)/,
  )
  assert.doesNotMatch(migration, /candidate ->> 'alias'/)
  assert.doesNotMatch(migration, /group_domain/)
})

test("database certification and verification fail closed until exact group SMTP truth is fresh", async () => {
  const { migration, historicalSnapshotMigration } = await sources()

  assert.match(
    migration,
    /create or replace function public\.outlook_exchange_projection_has_exact_group_smtp/,
  )
  assert.match(
    migration,
    /group_value ->> 'smtpAddress'[\s\S]*pg_catalog\.split_part\([\s\S]*is distinct from group_value ->> 'alias'/,
  )
  assert.match(
    migration,
    /pg_catalog\.split_part\([\s\S]*'@',[\s\S]*2[\s\S]*is distinct from 'cosulich1\.onmicrosoft\.com'/,
  )
  assert.match(
    migration,
    /create or replace function public\.outlook_exchange_worker_supports_group_smtp/,
  )
  assert.match(
    migration,
    /worker_date_value := worker_date::date[\s\S]*to_char\(worker_date_value, 'YYYY-MM-DD'\)/,
  )
  assert.match(
    migration,
    /fcuno-exchange-runbook\/2026-07-23\.3/,
  )
  assert.match(
    historicalSnapshotMigration,
    /create or replace function public\.outlook_exchange_truth_snapshot_is_valid\([\s\S]*fcuno_exchange_projection/,
  )
  assert.doesNotMatch(
    historicalSnapshotMigration,
    /outlook_exchange_projection_has_exact_group_smtp/,
  )
  assert.match(
    migration,
    /create or replace function public\.certify_full_outlook_exchange_truth\([\s\S]*outlook_exchange_projection_has_exact_group_smtp/,
  )
  assert.match(
    migration,
    /create trigger enforce_outlook_exchange_projection_group_smtp[\s\S]*before insert on public\.outlook_exchange_truth_snapshots/,
  )
  assert.match(
    migration,
    /create or replace function public\.verify_outlook_exchange_truth_ledger\(\)[\s\S]*'groupSmtpTruthValid'/,
  )
  assert.match(
    migration,
    /create or replace function public\.is_valid_outlook_template_recipient_resolution\([\s\S]*not \(ref_value \?& array\['kind', 'status'\]\)[\s\S]*ref_status is null[\s\S]*ref_kind is null/,
  )
  assert.doesNotMatch(migration, /declare\s*\ndeclare/)
})

test("template saves retain stable source identity across certified renames and removals", async () => {
  const { resolver } = await sources()
  const emailTemplates = await readFile(
    new URL("../lib/emailTemplates.ts", import.meta.url),
    "utf8",
  )

  assert.match(resolver, /previousStableSourceId/)
  assert.match(resolver, /lookups\.bySourceKey\.get/)
  assert.match(
    resolver,
    /kind: previousRef\.kind,[\s\S]*sourceId: previousStableSourceId,[\s\S]*resolvedAddress: null,[\s\S]*status: "missing"/,
  )
  assert.match(
    emailTemplates,
    /recipientResolver\.resolve\(\{[\s\S]*?\}, asPreviousRecipientResolution\(template\.recipientResolution\)\)/,
  )
  assert.match(
    emailTemplates,
    /recipientResolver\.resolve\(\{[\s\S]*?\}, asPreviousRecipientResolution\(nextTemplate\.recipientResolution\)\)/,
  )
})
