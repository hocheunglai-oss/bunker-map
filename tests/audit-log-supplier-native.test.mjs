import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { spcStemFixtureSql } from "./fixtures/spc-stem-sql.mjs"
import { createAuditConsumers, supplierAuditActor } from "./fixtures/audit-log-consumers.mjs"

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const sql = `${spcStemFixtureSql()}
${read("supabase/office_calendar_store.sql")}
grant select,insert,update,delete on public.office_calendar_store to service_role;
update public.spc_users set username=${literal(supplierAuditActor.username)},display_name=${literal(supplierAuditActor.displayName)} where id=${literal(supplierAuditActor.userId)};
${read("supabase/migrations/20261016021125_atomic_spc_supplier_store.sql")}`

test("actual native supplier RPC audit rows are visible to SPC consumers and never reach whole-store undo", async () => {
  const fixture = await setupNativeCcinfo(sql)
  try {
    const service = await fixture.session("supplier-audit-producer")
    await service.begin()
    await service.query(`do $$ begin perform set_config('request.headers',${literal(JSON.stringify({
      "x-bunker-admin-user": `spc:${supplierAuditActor.username}`, "x-bunker-audit-actor-user-id": supplierAuditActor.userId,
      "x-bunker-admin-page-id": "spc-suppliers", "x-bunker-admin-page-label": "SUPPLIER DATABASE", "x-bunker-admin-page-path": "/spc/suppliers",
    }))},true); end $$;`)
    const payload = { records: [], barges: [], contacts: [], receipts: [] }
    await service.one(`select public.compare_and_swap_spc_supplier_store(null,${literal(JSON.stringify(payload))}::jsonb,false,${literal(supplierAuditActor.username)},${literal(randomUUID())},'save');`)
    await service.query("commit;")
    const rows = await fixture.owner.one("select jsonb_agg(to_jsonb(t)) from public.audit_logs t;")
    assert.equal(rows.length, 1); assert.equal(rows[0].table_name, "office_calendar_store")
    assert.equal(rows[0].after_row.key, "spc-supplier-overrides"); assert.equal(rows[0].actor_user_id, supplierAuditActor.userId)
    const before = await fixture.owner.one("select jsonb_build_object('store',(select jsonb_agg(to_jsonb(t)) from public.office_calendar_store t),'audit',(select jsonb_agg(to_jsonb(t)) from public.audit_logs t));")
    const app = createAuditConsumers({ rows })
    const list = await app.request("spc", "?page=spc-suppliers")
    assert.equal(list.status, 200); assert.equal(list.body.logs.length, 1); assert.equal(list.body.logs[0].undoable, false)
    assert.equal(list.body.logs[0].summary, "Saved supplier details.")
    const detail = await app.request("spc", `?id=${rows[0].id}`)
    assert.equal(detail.status, 200); assert.equal(detail.body.log.detailsLoaded, true)
    assert.equal(detail.body.log.summary, "Saved supplier details.")
    assert.equal((await app.request("www", `?id=${rows[0].id}`)).status, 404)
    assert.equal((await app.request("spc", "", "POST", { action: "undo", id: rows[0].id })).status, 400)
    assert.equal(app.undoCalls(), 0)
    const after = await fixture.owner.one("select jsonb_build_object('store',(select jsonb_agg(to_jsonb(t)) from public.office_calendar_store t),'audit',(select jsonb_agg(to_jsonb(t)) from public.audit_logs t));")
    assert.deepEqual(after, before)
  } finally { await fixture.close() }
})
