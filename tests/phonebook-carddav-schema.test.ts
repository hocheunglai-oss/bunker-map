import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const migrationHead = "20260930074908"
const migration = readFileSync(new URL(
  `../supabase/migrations/${migrationHead}_phonebook_carddav_authoritative_reconciliation.sql`,
  import.meta.url,
), "utf8")
const tables = ["phonebook_carddav_queue", "phonebook_carddav_quarantine"]

test("server queue and quarantine are service-only with RLS and epoch fencing", () => {
  for (const table of tables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`))
    assert.match(migration, new RegExp(`revoke all on public\\.${table}\\s+from public, anon, authenticated, service_role`))
    assert.match(migration, new RegExp(
      `after insert or update or delete or truncate on public\\.${table}\\s+for each statement execute function private\\.record_bunker_map_backup_mutation\\(\\)`,
    ))
  }
  assert.match(migration, /grant update \(deleted_at\) on public\.phonebook_carddav_quarantine to service_role/)
  assert.doesNotMatch(migration, /grant (?:all|delete|update,) [^;]*phonebook_carddav_quarantine/)
  assert.doesNotMatch(migration, /references public\.phonebook_contacts/)
})

test("atomic enqueue invalidates stale acknowledgments and survives contact deletes", () => {
  assert.match(migration, /function public\.enqueue_phonebook_carddav\(p_contact_ids uuid\[\]\)[\s\S]*?security invoker/)
  assert.match(migration, /cardinality\(p_contact_ids\) > 5000/)
  assert.match(migration, /array_position\(p_contact_ids, null\)/)
  assert.match(migration, /on conflict \(contact_id\) do update set\s+version = gen_random_uuid\(\)/)
  assert.match(migration, /tg_op = 'DELETE'[\s\S]*?array\[old\.id\]/)
  assert.match(migration, /old\.id is distinct from new\.id[\s\S]*?array\[old\.id, new\.id\]/)
  assert.match(migration, /upper\(btrim\(contacts\.company\)\) = upper\(btrim\(old_name\)\)/)
  assert.match(migration, /upper\(btrim\(contacts\.company\)\) = upper\(btrim\(new_name\)\)/)
  for (const source of ["contacts", "companies"]) {
    assert.match(migration, new RegExp(
      `after insert or update or delete on public\\.phonebook_${source}\\s+for each row`,
    ))
  }
})

test("all backup consumers include both tables only after their introducing migration", () => {
  for (const file of [
    "app/api/backups/bunker-map-drive/route.ts",
    "lib/systemHealth.ts",
    "scripts/validate-backup.mjs",
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    assert.match(source, new RegExp(`PHONEBOOK_CARDDAV_RECONCILIATION_MIGRATION_HEAD = "${migrationHead}"`))
    for (const table of tables) {
      assert.match(source, new RegExp(`table: "${table}",[\\s\\S]{0,120}?introducedAt: PHONEBOOK_CARDDAV_RECONCILIATION_MIGRATION_HEAD`))
    }
  }
})

test("quarantine is bounded, uniquely recoverable, and never backfilled from the source table", () => {
  assert.match(migration, /octet_length\(vcard\) between 1 and 1048576/)
  assert.match(migration, /unique \(address_book_hash, resource_path, content_sha256\)/)
  assert.match(migration, /reason in \('unmanaged', 'orphan'\)/)
  assert.match(migration, /No initial full-book enqueue/)
  assert.equal((migration.match(/insert into public\.phonebook_carddav_queue/g) || []).length, 2)
})
