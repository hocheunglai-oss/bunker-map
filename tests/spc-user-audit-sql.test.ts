import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const baseline = readFileSync(
  new URL("../supabase/audit_log.sql", import.meta.url),
  "utf8",
)
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260806110014_harden_spc_user_management_audit.sql",
    import.meta.url,
  ),
  "utf8",
)
const completionMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260806202000_complete_spc_audit_enforcement.sql",
    import.meta.url,
  ),
  "utf8",
)
const partialUndoMigration = readFileSync(
  new URL(
    "../supabase/migrations/20260806204000_block_partial_spc_permission_audit_undo.sql",
    import.meta.url,
  ),
  "utf8",
)
const pgTap = readFileSync(
  new URL("../supabase/tests/spc_user_management_audit_test.sql", import.meta.url),
  "utf8",
)

for (const [name, sql] of [
  ["audit baseline", baseline],
  ["generated migration", migration],
] as const) {
  test(`${name} records shared SPC permission-store writes with investigation context`, () => {
    assert.match(sql, /'event-calendar', 'task-calendar', 'spc-permission-groups'/)
    assert.match(sql, /x-bunker-audit-source-ip/)
    assert.match(sql, /x-bunker-audit-correlation-id/)
    assert.match(sql, /x-bunker-audit-request-id/)
    assert.match(sql, /x-bunker-audit-platform-request-id/)
    assert.match(sql, /x-bunker-audit-actor-role/)
    assert.match(sql, /x-bunker-audit-action/)
    assert.match(sql, /x-bunker-audit-target-type/)
    assert.match(sql, /x-bunker-audit-outcome/)
    assert.match(sql, /x-bunker-audit-approval-reference/)
    assert.match(sql, /create or replace function public\.audit_uuid_text/)
  })

  test(`${name} protects SPC user-management evidence as append-only`, () => {
    assert.match(sql, /spc_user_management_events/)
    assert.match(sql, /SPC user-management audit records are append-only\./)
    assert.match(
      sql,
      /to_jsonb\(new\) - array\['undone_at', 'undone_by_log_id'\]/,
    )
    assert.match(sql, /current_setting\('app\.audit_undo_of_log_id', true\)/)
    assert.match(sql, /before insert or update or delete on public\.audit_logs/)
    assert.match(sql, /before truncate on public\.audit_logs/)
  })
}

test("the generated migration re-enables the shared-store audit trigger", () => {
  assert.match(
    migration,
    /audit_enable_table\('public\.office_calendar_store'::regclass\)/,
  )
})

test("the additive migration deterministically covers both SPC audit sinks", () => {
  assert.match(completionMigration, /to_regclass\('public\.spc_users'\)/)
  assert.match(
    completionMigration,
    /to_regclass\('public\.office_calendar_store'\)/,
  )
  assert.match(
    completionMigration,
    /grant usage on schema private to service_role/,
  )
  assert.match(
    completionMigration,
    /grant execute on function private\.is_spc_user_management_audit_record\(public\.audit_logs\)[\s\S]*to service_role/,
  )
})

test("undo audit context preserves trusted request investigation references", () => {
  for (const sql of [baseline, completionMigration]) {
    assert.match(sql, /create or replace function public\.audit_undo_context/)
    assert.match(sql, /x-bunker-audit-source-ip/)
    assert.match(sql, /x-bunker-audit-correlation-id/)
    assert.match(sql, /x-bunker-audit-request-id/)
    assert.match(sql, /x-bunker-audit-platform-request-id/)
    assert.match(sql, /public\.audit_undo_context\(p_log_id\)::text/)
  }
})

test("SPC permission/profile state cannot be partially restored by audit undo", () => {
  for (const sql of [baseline, partialUndoMigration]) {
    assert.match(sql, /block_spc_permission_store_partial_undo/)
    assert.match(sql, /current_setting\('app\.audit_undo_of_log_id', true\)/)
    assert.match(sql, /spc-permission-groups/)
    assert.match(sql, /before insert or update or delete on public\.office_calendar_store/)
    assert.match(
      sql,
      /SPC permission-group audit records cannot be undone independently/,
    )
  }
})

test("pgTAP exercises synthetic evidence as service_role and both table triggers", () => {
  assert.match(pgTap, /has_trigger\([\s\S]*?'spc_users'[\s\S]*?'bunker_audit_log'/)
  assert.match(pgTap, /set local role service_role;/)
  assert.match(pgTap, /reset role;/)
  assert.match(pgTap, /service_role can append a valid schema-constrained security event/)
})
