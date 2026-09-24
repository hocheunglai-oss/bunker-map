import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { buildHealthAlertHtml, deliverHealthAlerts, healthAlertObservation, type HealthAlertStore } from "../lib/systemHealthAlerts"
import type { HealthCheck } from "../lib/systemHealth"

const check: HealthCheck = {
  id: "drive-file-content-backup", label: "Drive File Content Backup", status: "warning",
  message: "One file is overdue for backup", checkedAt: "2026-09-23T00:30:00.000Z",
  details: { alertLevel: 1, notificationEligible: true, incidentResolved: false },
}

test("pending results preserve an incident; confirmed recovery clears it", () => {
  assert.equal(healthAlertObservation({ ...check, status: "ok", details: { incidentResolved: false } }, false).alert_level, null)
  assert.equal(healthAlertObservation({ ...check, status: "ok", details: { incidentResolved: true } }, false).alert_level, 0)
  assert.equal(healthAlertObservation({ ...check, details: { notificationEligible: false } }, false).alert_level, null)
  assert.equal(healthAlertObservation(check, true).alert_level, null)
  assert.equal(healthAlertObservation(check, false).alert_level, 1)
  assert.equal(healthAlertObservation({ ...check, details: { alertLevel: 2 } }, false).alert_level, 2)
  assert.equal(healthAlertObservation({ ...check, status: "error", details: { alertLevel: 1 } }, false).alert_level, 1)
})

test("no claim means no email and no delivery acknowledgement", async () => {
  const store: HealthAlertStore = { claim: async () => [], finish: async () => assert.fail("no claim") }
  const result = await deliverHealthAlerts({ checks: [check], muted: () => false, token: "test", store, send: async () => assert.fail("duplicate email") })
  assert.deepEqual(result, [])
})

test("only claimed checks are sent, then delivery is acknowledged", async () => {
  const sequence: string[] = []
  const store: HealthAlertStore = {
    claim: async (observations) => {
      assert.equal(observations.length, 2)
      sequence.push("claim")
      return [check.id]
    },
    finish: async (token, delivered) => {
      assert.equal(token, "test")
      assert.equal(delivered, true)
      sequence.push("acknowledge")
    },
  }
  await deliverHealthAlerts({ checks: [check, { ...check, id: "other" }], muted: () => false, token: "test", store,
    send: async (checks) => { assert.deepEqual(checks, [check]); sequence.push("send") },
  })
  assert.deepEqual(sequence, ["claim", "send", "acknowledge"])
})

test("failed sends release claims without advancing the notified level", async () => {
  const results: boolean[] = []
  await assert.rejects(deliverHealthAlerts({ checks: [check], muted: () => false, token: "test",
    store: { claim: async () => [check.id], finish: async (_, delivered) => { results.push(delivered) } },
    send: async () => { throw new Error("SMTP unavailable") },
  }), /SMTP unavailable/)
  assert.deepEqual(results, [false])
})

test("failed acknowledgement after send keeps lease rather than inviting immediate duplicates", async () => {
  const results: boolean[] = []
  await assert.rejects(deliverHealthAlerts({ checks: [check], muted: () => false, token: "test",
    store: { claim: async () => [check.id], finish: async (_, delivered) => { results.push(delivered); throw new Error("DB unavailable") } },
    send: async () => {},
  }), /DB unavailable/)
  assert.deepEqual(results, [true])
})

test("unavailable persistent deduplication never falls back to sending every day", async () => {
  await assert.rejects(deliverHealthAlerts({ checks: [check], muted: () => false, token: "test",
    store: { claim: async () => { throw new Error("DB unavailable") }, finish: async () => {} },
    send: async () => assert.fail("unclaimed email"),
  }), /DB unavailable/)
})

test("email is concise, uses HKT, escapes file names, and omits technical dump", () => {
  const html = buildHealthAlertHtml([{ ...check, details: {
    missingFileNames: '<img src=x onerror="bad()">', lastSuccessfulBackupAt: "2026-09-22T18:05:00Z",
    action: "Check backup job", artifactSha256: "internalhash", ageHours: 25,
  } }], check.checkedAt)
  assert.match(html, /23 Sept 2026, 02:05 HKT/)
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img|internalhash|artifactSha256|ageHours|<table/)
  assert.match(html, /https:\/\/fcuno.com\/admin\/systemhealth/)
})

test("notification state is private, service-only, and not a new business-backup table", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20260924022019_system_health_alert_incidents.sql", import.meta.url), "utf8")
  assert.match(sql, /create table private\.system_health_alert_incidents/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /security invoker set search_path = ''/)
  assert.match(sql, /revoke all on function public\.claim_system_health_alerts\(jsonb, uuid, text\) from public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.claim_system_health_alerts\(jsonb, uuid, text\) to service_role/)
  assert.doesNotMatch(sql, /create table public\./)
})
