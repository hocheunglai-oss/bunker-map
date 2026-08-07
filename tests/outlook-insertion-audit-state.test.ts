import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  getOutlookInsertionAuditRecordLabel,
  getOutlookInsertionAuditPresentation,
  type AuditLogRecord,
} from "../lib/auditLog"

const migrationFile = new URL(
  "../supabase/migrations/20260723141044_outlook_insertion_audit_state_machine.sql",
  import.meta.url,
)
const auditBaselineFile = new URL("../supabase/audit_log.sql", import.meta.url)
const taskpaneFile = new URL(
  "../app/api/outlook-addin/taskpane/route.ts",
  import.meta.url,
)
const adminAuditRouteFile = new URL(
  "../app/api/admin/audit-logs/route.ts",
  import.meta.url,
)

function insertionEvent(input: {
  id: string
  occurredAt: string
  phase: "reserved" | "terminal"
  outcome?: "inserted" | "failed-restored" | "failed-preserved"
  reservationAuditLogId?: string
}): AuditLogRecord {
  const operationId = "11111111-1111-4111-8111-111111111111"
  const afterRow: Record<string, unknown> = {
    schema: "fcuno.outlook-template-insertion-audit/v2",
    phase: input.phase,
    operationId,
    templateId: "template-1",
    templateRevision: 7,
    certificationRunId: "22222222-2222-4222-8222-222222222222",
    sourceFingerprint: "a".repeat(64),
    eventAt: input.occurredAt,
  }
  if (input.phase === "reserved") {
    afterRow.templateTitle = "Daily Bunker Update"
  }
  if (input.phase === "terminal") {
    afterRow.outcome = input.outcome
    afterRow.reservationAuditLogId = input.reservationAuditLogId
  }

  return {
    id: input.id,
    occurredAt: input.occurredAt,
    actorUserId: null,
    actorId: "sc",
    actorName: "SC",
    actorSource: "app",
    tableSchema: "app",
    tableName: "outlook_template_insertion_attempts",
    operation: "INSERT",
    recordPk: {
      operationId,
      phase: input.phase,
      templateId: "template-1",
      templateRevision: 7,
    },
    changedFields: [],
    beforeRow: null,
    afterRow,
    requestContext: {
      pageId: "email-templates",
      action: `outlook-draft-insertion-${input.phase}`,
      auditPhase: input.phase,
    },
    undoOfLogId: null,
    undoneAt: null,
    undoneByLogId: null,
  }
}

test("database enforces append-only reservation and one terminal phase per operation", async () => {
  const [migration, baseline] = await Promise.all([
    readFile(migrationFile, "utf8"),
    readFile(auditBaselineFile, "utf8"),
  ])

  for (const sql of [migration, baseline]) {
    assert.match(
      sql,
      /drop index if exists[\s\S]*audit_logs_outlook_template_insertion_operation_id_key/,
    )
    assert.match(
      sql,
      /create unique index if not exists[\s\S]*record_pk ->> 'operationId'[\s\S]*record_pk ->> 'phase'/,
    )
    assert.match(
      sql,
      /event_phase is null\s+or event_phase not in \('reserved', 'terminal'\)/,
    )
    assert.match(
      sql,
      /event_outcome is null\s+or event_outcome not in \([\s\S]*'inserted'[\s\S]*'failed-restored'[\s\S]*'failed-preserved'/,
    )
    assert.match(
      sql,
      /record_pk ->> 'phase' = 'reserved'/,
    )
    assert.match(
      sql,
      /A matching Outlook template insertion reservation is required before a terminal event/,
    )
    assert.match(
      sql,
      /Outlook template insertion audit events are append-only/,
    )
    assert.match(
      sql,
      /before insert or update or delete on public\.audit_logs/,
    )
    assert.match(
      sql,
      /current_setting\([\s\S]*'app\.outlook_insertion_reservation_operation_id'[\s\S]*is distinct from new\.record_pk ->> 'operationId'/,
    )
    assert.match(sql, /new\.operation is distinct from 'INSERT'/)
    assert.match(sql, /new\.actor_source is distinct from 'app'/)
    assert.match(
      sql,
      /request_context ->> 'auditOutcome'\s+is distinct from event_outcome/,
    )
    assert.match(
      sql,
      /'templateTitle'[\s\S]*jsonb_typeof\(new\.after_row -> 'templateTitle'\)/,
    )
  }

  const stateMachineStart =
    "drop index if exists\n  public.audit_logs_outlook_template_insertion_operation_id_key;"
  assert.equal(
    baseline.slice(baseline.lastIndexOf(stateMachineStart)),
    migration.slice(migration.indexOf(stateMachineStart)),
    "baseline and forward migration must keep the insertion state machine identical",
  )
})

test("database atomically validates and reserves exact current template truth", async () => {
  const migration = await readFile(migrationFile, "utf8")

  assert.match(
    migration,
    /create or replace function public\.reserve_outlook_template_insertion\(/,
  )
  assert.match(migration, /security invoker/)
  assert.match(
    migration,
    /pg_advisory_xact_lock\(\s*913047563612485921::bigint\s*\)/,
  )
  assert.match(
    migration,
    /pg_advisory_xact_lock\([\s\S]*hashtextextended\('email_templates_canonical_write', 0\)/,
  )
  assert.match(
    migration,
    /hashtextextended\([\s\S]*'outlook_template_insertion_operation:'[\s\S]*p_operation_id::text/,
  )
  assert.match(migration, /for share;/)
  assert.match(
    migration,
    /recipient_resolution ->> 'reconciliationRequired'[\s\S]*is distinct from 'false'/,
  )
  assert.match(
    migration,
    /verify_outlook_template_recipient_truth\(\)[\s\S]*verify_outlook_exchange_truth_ledger\(\)/,
  )
  for (const field of [
    "valid",
    "integrityValid",
    "ledgerValid",
    "snapshotsValid",
    "referencesValid",
    "operationallyConsistent",
    "latestCertificationHasProjectionEvidence",
  ]) {
    assert.match(migration, new RegExp(`exchange_truth ->> '${field}'`))
  }
  for (const queueStatus of [
    "pending",
    "processing",
    "failed",
    "terminalFailed",
  ]) {
    assert.match(
      migration,
      new RegExp(`queue_state ->> '${queueStatus}'[\\s\\S]*is distinct from '0'`),
    )
  }
  assert.match(
    migration,
    /latest_certified_at[\s\S]*p_certification_max_age_seconds/,
  )
  assert.match(
    migration,
    /recipient_resolution ->> 'reconciliationRequired'\s+is distinct from 'false'/,
  )
  assert.match(
    migration,
    /set_config\([\s\S]*'app\.outlook_insertion_reservation_operation_id'/,
  )
  assert.match(
    migration,
    /insert into public\.audit_logs[\s\S]*returning id into inserted_audit_log_id/,
  )
  assert.match(migration, /reservation_is_idempotent := true/)
  assert.match(migration, /OUTLOOK_INSERTION_OPERATION_CONFLICT/)
  assert.match(
    migration,
    /reservation_is_idempotent[\s\S]*OUTLOOK_INSERTION_OPERATION_COMPLETED/,
  )
  assert.match(
    migration,
    /reservation_ttl_seconds constant integer := 120;[\s\S]*if reservation_is_idempotent[\s\S]*reservation_record\.occurred_at[\s\S]*OUTLOOK_INSERTION_RESERVATION_EXPIRED/,
  )
  assert.match(
    migration,
    /coalesce\(normalized_fingerprint, ''\) !~ '\^\[0-9a-f\]\{64\}\$'/,
  )
  const truthValidationIndex = migration.indexOf(
    "template_truth := public.verify_outlook_template_recipient_truth();",
  )
  const idempotentReturnIndex = migration.indexOf(
    "if reservation_is_idempotent then",
  )
  assert.ok(truthValidationIndex >= 0)
  assert.ok(idempotentReturnIndex > truthValidationIndex)
  assert.match(
    migration,
    /'templateTitle', template_record\.title/,
  )
  assert.match(
    migration,
    /reservation_is_idempotent[\s\S]*reservation_record\.after_row ->> 'templateTitle'[\s\S]*is distinct from template_record\.title/,
  )
  assert.match(
    migration,
    /grant execute on function public\.reserve_outlook_template_insertion\(\s*uuid,\s*text,\s*bigint,\s*uuid,\s*text,\s*text,\s*text,\s*integer\s*\)\s*to service_role;/,
  )
  assert.match(
    migration,
    /revoke all on function public\.reserve_outlook_template_insertion[\s\S]*from public, anon, authenticated;[\s\S]*grant execute[\s\S]*to service_role;/,
  )
})

test("database atomically finalizes one server-timestamped terminal outcome", async () => {
  const migration = await readFile(migrationFile, "utf8")

  assert.match(
    migration,
    /create or replace function public\.complete_outlook_template_insertion\(/,
  )
  assert.match(
    migration,
    /complete_outlook_template_insertion[\s\S]*pg_advisory_xact_lock\([\s\S]*outlook_template_insertion_operation:/,
  )
  assert.match(
    migration,
    /OUTLOOK_INSERTION_RESERVATION_REQUIRED[\s\S]*OUTLOOK_INSERTION_TERMINAL_CONFLICT/,
  )
  assert.match(
    migration,
    /normalized_outcome is null[\s\S]*normalized_outcome not in/,
  )
  assert.match(
    migration,
    /'idempotent', true,[\s\S]*'outcome', normalized_outcome/,
  )
  assert.match(
    migration,
    /event_time := pg_catalog\.clock_timestamp\(\);[\s\S]*occurred_at[\s\S]*'eventAt', event_time/,
  )
  const terminalFunctionIndex = migration.indexOf(
    "create or replace function public.complete_outlook_template_insertion(",
  )
  const terminalIdempotentReturnIndex = migration.indexOf(
    "'idempotent', true,",
    terminalFunctionIndex,
  )
  const terminalExpiryIndex = migration.indexOf(
    "OUTLOOK_INSERTION_RESERVATION_EXPIRED",
    terminalFunctionIndex,
  )
  const terminalInsertIndex = migration.indexOf(
    "insert into public.audit_logs",
    terminalFunctionIndex,
  )
  assert.ok(terminalIdempotentReturnIndex >= 0)
  assert.ok(terminalExpiryIndex > terminalIdempotentReturnIndex)
  assert.ok(terminalInsertIndex > terminalExpiryIndex)
  assert.match(
    migration,
    /revoke all on function public\.complete_outlook_template_insertion[\s\S]*from public, anon, authenticated;[\s\S]*grant execute[\s\S]*to service_role;/,
  )
})

test("server uses only atomic database RPCs for reservation and terminal outcome", async () => {
  const taskpane = await readFile(taskpaneFile, "utf8")
  const server = taskpane.split("export async function GET")[0]

  assert.match(taskpane, /type InsertionAuditPhase = "reserved" \| "terminal"/)
  assert.match(
    taskpane,
    /type InsertionAuditOutcome =[\s\S]*"inserted"[\s\S]*"failed-restored"[\s\S]*"failed-preserved"/,
  )
  assert.match(
    taskpane,
    /if \(typedPhase === "reserved"\)[\s\S]*\.rpc\(\s*"reserve_outlook_template_insertion"/,
  )
  assert.doesNotMatch(taskpane, /validateInsertionReservation/)
  assert.doesNotMatch(taskpane, /loadEmailTemplate/)
  assert.match(
    taskpane,
    /p_certification_max_age_seconds: certificationMaxAgeSeconds\(\)/,
  )
  assert.match(
    taskpane,
    /certificationRunId = String\([\s\S]*\.toLowerCase\(\)/,
  )
  assert.match(taskpane, /templateRevision > 2147483647/)
  assert.match(taskpane, /OUTLOOK_INSERTION_TEMPLATE_CHANGED/)
  assert.match(taskpane, /OUTLOOK_INSERTION_TRUTH_STALE/)
  assert.match(
    taskpane,
    /\.rpc\(\s*"complete_outlook_template_insertion"[\s\S]*p_outcome: typedOutcome!/,
  )
  assert.match(taskpane, /OUTLOOK_INSERTION_OPERATION_COMPLETED/)
  assert.match(taskpane, /OUTLOOK_INSERTION_RESERVATION_EXPIRED/)
  assert.match(taskpane, /OUTLOOK_INSERTION_RESERVATION_REQUIRED/)
  assert.match(taskpane, /OUTLOOK_INSERTION_TERMINAL_CONFLICT/)
  assert.doesNotMatch(server, /\.from\("audit_logs"\)\.insert/)
  assert.doesNotMatch(server, /new Date\(/)
  assert.doesNotMatch(server, /loadExistingInsertionEvent/)
})

test("Audit Log makes incomplete and terminal insertion status explicit", () => {
  const reservation = insertionEvent({
    id: "33333333-3333-4333-8333-333333333333",
    occurredAt: "2026-07-23T12:00:00.000Z",
    phase: "reserved",
  })
  const terminal = insertionEvent({
    id: "44444444-4444-4444-8444-444444444444",
    occurredAt: "2026-07-23T12:00:01.000Z",
    phase: "terminal",
    outcome: "inserted",
    reservationAuditLogId: reservation.id,
  })

  const incomplete = getOutlookInsertionAuditPresentation(
    reservation,
    "template-1",
  )
  assert.match(incomplete.summary, /terminal status is missing \(incomplete\)/)
  assert.match(incomplete.details.join(" "), /Status: incomplete/)

  const completedReservation = getOutlookInsertionAuditPresentation(
    reservation,
    "template-1",
    [terminal],
  )
  assert.match(completedReservation.summary, /completed as inserted/)
  assert.match(completedReservation.details.join(" "), new RegExp(terminal.id))

  const completedTerminal = getOutlookInsertionAuditPresentation(
    terminal,
    "Daily Bunker Update",
    [reservation],
  )
  assert.equal(
    completedTerminal.summary,
    'Inserted Outlook template "Daily Bunker Update" into an Outlook message.',
  )
  assert.match(completedTerminal.details.join(" "), new RegExp(reservation.id))

  assert.equal(
    getOutlookInsertionAuditRecordLabel(terminal, [reservation]),
    "Daily Bunker Update",
  )
})

test("Outlook insertion events remain visible under the Outlook Templates Audit Log filter", async () => {
  const auditRoute = await readFile(adminAuditRouteFile, "utf8")

  assert.match(
    auditRoute,
    /"email-templates": \[[\s\S]*"email_templates",[\s\S]*"outlook_template_insertion_attempts"/,
  )
})
