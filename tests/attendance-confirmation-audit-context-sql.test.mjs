import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const auditSource = source("supabase/audit_log.sql")
const auditStart = auditSource.indexOf("create table if not exists public.audit_logs (")
const enableStart = auditSource.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
const auditEnd = auditSource.indexOf("$$;", enableStart) + 3
assert.ok(auditStart >= 0 && enableStart > auditStart && auditEnd > enableStart)
const audit = auditSource.slice(auditStart, auditEnd)
const migration = source("supabase/migrations/20261014082839_attendance_confirmation_audit_context.sql")
const person = "11111111-1111-4111-8111-111111111111"
const signature = "public.save_attendance_monthly_confirmation_checked(uuid,integer,integer,text,text,text,bigint,timestamp with time zone)"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    ${audit}
    create table private.attendance_source_revision_state (
      singleton boolean primary key, revision bigint not null
    );
    insert into private.attendance_source_revision_state values (true, 7);
    create table public.attendance_monthly_confirmations (
      id uuid primary key default gen_random_uuid(),
      person_id uuid not null,
      year integer not null,
      month integer not null,
      status text not null,
      confirmed_at timestamptz,
      confirmed_by text,
      confirmed_source_revision bigint,
      note text not null default '',
      created_by text not null,
      updated_by text not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      unique (person_id, year, month)
    );
    grant select, insert, update on public.attendance_monthly_confirmations to service_role;
    ${migration}
    select public.audit_enable_table('public.attendance_monthly_confirmations'::regclass);
  `)
  const permissions = (await db.query(`select
    has_function_privilege('anon', '${signature}', 'EXECUTE') as anonymous,
    has_function_privilege('authenticated', '${signature}', 'EXECUTE') as authenticated,
    has_function_privilege('service_role', '${signature}', 'EXECUTE') as service
  `)).rows[0]
  assert.deepEqual(permissions, { anonymous: false, authenticated: false, service: true })
  await db.exec("set role service_role")
  const save = async ({ month = 9, status = "confirmed", note = "reviewed",
    actor = "system:attendance-auto-confirm", expectedRevision = 7,
    cutoff = "2026-10-05T10:00:00Z" } = {}) => db.query(
    `select * from public.save_attendance_monthly_confirmation_checked(
      $1, 2025, $2, $3, $4, $5, $6, $7
    )`,
    [person, month, status, note, actor, expectedRevision, cutoff],
  )
  const logs = async () => (await db.query(`select actor_id, actor_source, operation,
    request_context, after_row from public.audit_logs
    where table_name = 'attendance_monthly_confirmations' order by occurred_at, id`)).rows
  return { db, save, logs }
}

test("checked attendance confirmation writes an attributed audit event atomically", async () => {
  const app = await setup()
  try {
    await app.db.exec("begin")
    await app.db.query("select set_config('app.audit_context', $1, true)", [JSON.stringify({
      approvalReference: "synthetic-review", pageId: "old-page", customMarker: "kept",
    })])
    const saved = (await app.save()).rows
    assert.equal(saved.length, 1)
    assert.equal(saved[0].status, "confirmed")
    assert.equal(Number(saved[0].confirmed_source_revision), 7)
    await app.db.exec("commit")

    let logs = await app.logs()
    assert.equal(logs.length, 1)
    assert.equal(logs[0].actor_id, "system:attendance-auto-confirm")
    assert.equal(logs[0].actor_source, "app")
    assert.equal(logs[0].operation, "INSERT")
    assert.equal(logs[0].request_context.approvalReference, "synthetic-review")
    assert.equal(logs[0].request_context.customMarker, "kept")
    assert.equal(logs[0].request_context.action, "attendance-auto-confirm")
    assert.equal(logs[0].request_context.pageId, "attendance-record")
    assert.equal(logs[0].request_context.personId, person)
    assert.equal(logs[0].request_context.year, 2025)
    assert.equal(logs[0].request_context.month, 9)
    assert.equal(logs[0].request_context.sourceRevision, 7)
    assert.equal(logs[0].after_row.confirmed_by, "system:attendance-auto-confirm")

    assert.equal((await app.save()).rows.length, 0)
    await assert.rejects(app.save({ month: 8, expectedRevision: 6 }), /ATTENDANCE_SOURCE_CHANGED/)
    assert.equal((await app.logs()).length, 1)

    const reset = (await app.save({ status: "pending", note: "admin review",
      actor: "admin:reviewer", cutoff: null })).rows
    assert.equal(reset.length, 1)
    assert.equal(reset[0].status, "pending")
    logs = await app.logs()
    assert.equal(logs.length, 2)
    const update = logs.find((row) => row.operation === "UPDATE")
    assert.ok(update)
    assert.equal(update.actor_id, "admin:reviewer")
    assert.equal(update.request_context.action, "attendance-confirmation-reset")
    assert.equal(update.request_context.approvalReference, undefined)
    assert.equal(update.after_row.confirmed_by, null)

    const cyActor = "system:attendance-cy-dingtalk-exception"
    const cyConfirmation = (await app.save({ month: 8, actor: cyActor,
      note: "DingTalk exception; no independent punch verification." })).rows
    assert.equal(cyConfirmation.length, 1)
    logs = await app.logs()
    assert.equal(logs.length, 3)
    const cyAudit = logs.find((row) => row.actor_id === cyActor)
    assert.ok(cyAudit)
    assert.equal(cyAudit.operation, "INSERT")
    assert.equal(cyAudit.request_context.month, 8)
    assert.equal(cyAudit.after_row.confirmed_by, cyActor)

    await app.db.exec("begin")
    await app.save({ month: 10, cutoff: null })
    await app.db.exec("rollback")
    assert.equal((await app.logs()).length, 3)
    assert.equal((await app.db.query(`select count(*)::integer as count
      from public.attendance_monthly_confirmations where month = 10`)).rows[0].count, 0)
  } finally {
    await app.db.close()
  }
})
