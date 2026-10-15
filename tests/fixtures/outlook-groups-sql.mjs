import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

export const groupCountMigrationPath = "supabase/migrations/20261015072659_serialize_outlook_group_membership_counts.sql"
const source = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const section = (sql, startText, endText) => {
  const start = sql.indexOf(startText), end = sql.indexOf(endText, start)
  assert.ok(start >= 0 && end > start, `Missing exact SQL fixture section: ${startText}`)
  return sql.slice(start, end)
}
const fn = (sql, name) => {
  const start = sql.indexOf(`create or replace function ${name}(`)
  const end = sql.indexOf("$$;", start) + 3
  assert.ok(start >= 0 && end > start, `Missing exact function ${name}`)
  return sql.slice(start, end)
}

// Actual source audit, queue, version, FK and backup functions; no cloud client,
// production data, mocked trigger, substituted count logic or pgcrypto shim.
// The independent hash ledger/Exchange delivery worker is outside this fixture.
export function outlookGroupsFixtureSql({ repaired = true } = {}) {
  const audit = source("supabase/audit_log.sql")
  const auditEnd = audit.indexOf("$$;", audit.indexOf("create or replace function public.audit_enable_table(")) + 3
  const outbox = source("supabase/migrations/20260722045125_exchange_sync_transactional_outbox.sql")
  const hardened = source("supabase/migrations/20260722082522_harden_exchange_queue_stale_claims.sql")
  const backup = source("supabase/migrations/20260723101257_add_backup_export_epoch.sql")
  const queue = source("supabase/outlook_exchange_sync_queue.sql")
  // Strip the canonical current counter so the RED fixture preserves the exact
  // installed old function before applying the new append-only migration.
  const schema = source("supabase/shared_address_book.sql").split("-- Transactional Exchange outbox")[0]
  return `set time zone 'UTC';
    create role anon; create role authenticated; create role service_role bypassrls;
    grant usage on schema public to service_role;
    ${audit.slice(audit.indexOf("create table if not exists public.audit_logs ("), auditEnd)}
    ${schema}
    ${section(queue, "create table if not exists public.outlook_exchange_sync_queue (", "create table if not exists public.outlook_exchange_sync_certifications (")}
    ${fn(outbox, "public.outlook_exchange_alias")}
    ${fn(outbox, "public.outlook_exchange_queue_source_change")}
    ${fn(source("supabase/migrations/20260806110014_harden_spc_user_management_audit.sql"), "public.audit_table_changes")}
    ${section(outbox, "create or replace function public.outlook_addressbook_touch_updated_at()", "drop trigger if exists outlook_exchange_queue_contact")}
    ${section(hardened, "drop trigger if exists outlook_exchange_queue_contact on", "create or replace function public.complete_verified_outlook_exchange_sync_queue_row(")}
    ${backup.slice(0, backup.indexOf("\ndo $$"))}
    ${["shared_addressbook_contacts", "shared_addressbook_groups", "shared_addressbook_group_members"].map(table => `select public.audit_enable_table('public.${table}');`).join("\n")}
    ${["shared_addressbook_contacts", "shared_addressbook_groups", "shared_addressbook_group_members", "outlook_exchange_sync_queue", "audit_logs"].map(table => `
      create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.${table}
        for each statement execute function private.record_bunker_map_backup_mutation();
    `).join("\n")}
    grant select,insert,update,delete on public.shared_addressbook_contacts,public.shared_addressbook_groups,public.shared_addressbook_group_members to service_role;
    grant select on public.outlook_exchange_sync_queue to service_role;
    ${repaired ? `begin; ${source(groupCountMigrationPath)} commit;` : ""}
  `
}

export const groupCountMigrationSql = () => source(groupCountMigrationPath)
