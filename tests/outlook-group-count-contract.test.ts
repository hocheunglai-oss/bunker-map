import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const migration = readFileSync(new URL("../supabase/migrations/20261015072659_serialize_outlook_group_membership_counts.sql", import.meta.url), "utf8")
const schema = readFileSync(new URL("../supabase/shared_address_book.sql", import.meta.url), "utf8")
const functionStart = "create or replace function public.outlook_addressbook_refresh_member_count()"
const body = (sql: string) => {
  const start = sql.indexOf(functionStart), end = sql.indexOf("$$;", start) + 3
  assert.ok(start >= 0 && end > start)
  return sql.slice(start, end)
}

test("canonical Outlook count function is byte-identical to the append-only migration", () => {
  assert.equal(body(schema), body(migration))
  assert.match(body(migration), /security invoker\s+set search_path = ''/)
  assert.match(body(migration), /language plpgsql\s+volatile/)
})

test("counter acquires stable parent locks before a separate fresh recount and unconditional version touch", () => {
  const sql = body(migration)
  const lock = sql.indexOf("for no key update of groups;"), recount = sql.indexOf("update public.shared_addressbook_groups", lock)
  assert.ok(lock > 0 && recount > lock)
  assert.match(sql.slice(0, lock), /order by groups\.id/)
  assert.match(sql.slice(recount), /select pg_catalog\.count\(\*\)::integer/)
  assert.doesNotMatch(sql.slice(recount), /member_count is distinct from/)
  for (const field of ["old.group_id", "new.group_id", "tg_table_schema", "tg_table_name", "tg_when", "tg_level"]) assert.ok(sql.includes(field))
})

test("migration fails closed on backup/writer contention and avoids healthy-row backfill writes", () => {
  const fence = migration.indexOf("pg_try_advisory_xact_lock_shared"), lock = migration.indexOf("lock table public.shared_addressbook_groups"), replacement = migration.indexOf(functionStart)
  assert.ok(fence >= 0 && lock > fence && replacement > lock)
  assert.match(migration.slice(0, replacement), /errcode = '55P03'/)
  assert.match(migration.slice(0, replacement), /in share row exclusive mode nowait;/)
  assert.match(migration, /set local lock_timeout = '1s'/)
  assert.match(migration, /revoke all on function public\.outlook_addressbook_refresh_member_count\(\)\s+from public, anon, authenticated, service_role;/)
  const backfill = migration.slice(migration.indexOf("-- Writers are excluded"))
  assert.match(backfill, /where groups\.member_count is distinct from/)
  assert.match(backfill, /for mismatched in[\s\S]*for no key update of groups[\s\S]*loop\s+update/)
  assert.doesNotMatch(migration, /grant\s+|disable trigger|session_replication_role|insert into public\.outlook_exchange_sync_queue/i)
})
