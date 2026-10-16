import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { spcSupplierFixtureSql } from "./fixtures/spc-supplier-sql.mjs"
import { supplierActor } from "./fixtures/spc-supplier-api.mjs"
const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const payload = { records: [], barges: [], contacts: [], receipts: [] }
const headers = { "x-bunker-admin-user": `spc:${supplierActor.username}`, "x-bunker-audit-actor-user-id": supplierActor.userId,
  "x-bunker-admin-page-id": "spc-suppliers", "x-bunker-admin-page-label": "SPC SUPPLIER DATABASE", "x-bunker-admin-page-path": "/spc/suppliers",
  "x-bunker-audit-correlation-id": "synthetic-correlation", "x-bunker-audit-request-id": "synthetic-request",
  "x-bunker-audit-platform-request-id": "synthetic-platform", "x-bunker-audit-source-ip": "192.0.2.1", "x-bunker-audit-actor-role": "ADMIN",
  "x-bunker-audit-action": "supplier-save", "x-bunker-audit-outcome": "success", "x-bunker-audit-target-type": "supplier" }
const call = async (db, expected = null, next = payload, exists = false) => (await db.query(
  "select public.compare_and_swap_spc_supplier_store($1::jsonb,$2::jsonb,$3,$4,$5::uuid,'save') as result",
  [expected == null ? null : JSON.stringify(expected), JSON.stringify(next), exists, supplierActor.username, randomUUID()])).rows[0].result
const state = async db => {
  await db.exec("reset role")
  try { return (await db.query(`select jsonb_build_object(
  'store',(select coalesce(jsonb_agg(to_jsonb(t) order by key),'[]') from public.office_calendar_store t),
  'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
  'fence',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t)) as state`)).rows[0].state }
  finally { await db.exec("set role service_role") }
}
test("portable supplier SQL CAS and audit transaction", async t => {
  const db = new PGlite()
  try {
    await db.exec(spcSupplierFixtureSql()); await db.exec("set role service_role")
    await db.query("select set_config('request.headers',$1,false)", [JSON.stringify(headers)])
    await t.test("first insert keeps one audit, one fence and all trusted trace headers", async () => {
      const result = await call(db); assert.equal(result.schema, "fcuno.supplier-store-cas/v1"); assert.deepEqual(result.payload, payload)
      const after = await state(db); assert.equal(after.store.length, 1); assert.equal(after.audit.length, 1); assert.equal(after.fence.length, 1)
      const audit = after.audit[0]; assert.equal(audit.operation, "INSERT"); assert.equal(audit.actor_user_id, supplierActor.userId)
      assert.equal(audit.request_context.correlationId, "synthetic-correlation"); assert.equal(audit.request_context.sourceIp, "192.0.2.1")
      assert.equal(audit.request_context.platformRequestId, "synthetic-platform"); assert.equal(audit.request_context.actorRole, "ADMIN")
    })
    await t.test("stale existing/absent snapshots reject without changing audit or fence", async () => {
      const before = await state(db)
      for (const args of [[null, payload, false], [{ ...payload, records: [{}] }, payload, true]]) {
        await assert.rejects(call(db, ...args), error => error.code === "40001" && error.detail === "supplier-store-cas-contention")
        assert.deepEqual(await state(db), before)
      }
    })
    await t.test("invalid collection shape and invalid exists flag fail before mutation", async () => {
      const before = await state(db)
      for (const bad of [{ ...payload, contacts: null }, { ...payload, barges: {} }, { ...payload, receipts: new Array(257).fill({}) }]) {
        await assert.rejects(call(db, payload, bad, true), error => error.code === "22023")
      }
      await assert.rejects(call(db, payload, payload, false), error => error.code === "22023")
      assert.deepEqual(await state(db), before)
    })
    for (const fault of ["exception", "suppress", "mutate"]) await t.test(`audit ${fault} aborts store, audit and backup fence together`, async () => {
      await db.exec(`reset role; create or replace function public.supplier_fault() returns trigger language plpgsql as $$ begin
        ${fault === "exception" ? "raise exception 'Synthetic audit failure';" : fault === "suppress" ? "return null;" : "new.after_row='{}';return new;"} end $$;
        create trigger supplier_fault before insert on public.audit_logs for each row execute function public.supplier_fault(); set role service_role;`)
      const before = await state(db)
      await assert.rejects(call(db, payload, { ...payload, synthetic: fault }, true), error => fault === "exception" || error.code === "40001")
      assert.deepEqual(await state(db), before)
      await db.exec("reset role; drop trigger supplier_fault on public.audit_logs; set role service_role;")
    })
    await t.test("service-only invoker/empty path and actual denied role execution", async () => {
      const metadata = (await db.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'execute') as anon,has_function_privilege('authenticated',oid,'execute') as auth,has_function_privilege('service_role',oid,'execute') as service from pg_proc where oid='public.compare_and_swap_spc_supplier_store(jsonb,jsonb,boolean,text,uuid,text)'::regprocedure")).rows[0]
      assert.deepEqual(metadata, { prosecdef: false, proconfig: ['search_path=""'], anon: false, auth: false, service: true })
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`reset role; set role ${role}`); await assert.rejects(call(db), error => error.code === "42501")
      }
      await db.exec("reset role; set role service_role")
      await db.query("select set_config('request.headers','{}',false)"); await assert.rejects(call(db), error => error.code === "42501")
    })
  } finally { await db.close() }
})
