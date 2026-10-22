import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { spcSupplierFixtureSql } from "./fixtures/spc-supplier-sql.mjs"
import { createSupplierRoute, supplierActor } from "./fixtures/spc-supplier-api.mjs"
import { nativeSpcPostgrestError } from "./fixtures/spc-write-conflicts-sql.mjs"

const json = value => value == null ? "null" : `${literal(JSON.stringify(value))}::jsonb`
const call = a => `select public.compare_and_swap_spc_supplier_store(${json(a.p_expected_payload)},${json(a.p_payload)},${a.p_expected_exists},${literal(a.p_actor_username)},${literal(a.p_request_id)},${literal(a.p_action)});`
const state = f => f.owner.one(`select jsonb_build_object(
  'store',(select coalesce(jsonb_agg(to_jsonb(t) order by key),'[]') from public.office_calendar_store t),
  'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
  'fence',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t));`)
const reset = f => f.owner.query("delete from public.office_calendar_store; delete from public.audit_logs; truncate private.bunker_map_backup_mutations;")
function app(f, options = {}) {
  const connection = f.session(`supplier-read-${randomUUID()}`)
  let lost = options.loseResponse, captured
  const route = createSupplierRoute({ permission: options.permission, optionalUnavailable: options.optionalUnavailable, sheetChildren: options.sheetChildren,
    createClient: headers => ({
      from(table) {
        if (table === "spc_fixtures") return { select() { return this }, eq() { return this }, order() { return this }, async range() { return { data: [], error: null } } }
        assert.equal(table, "office_calendar_store")
        return { select() { return this }, eq() { return this }, async maybeSingle() {
          const data = await (await connection).one("select coalesce((select to_jsonb(t) from public.office_calendar_store t where key='spc-supplier-overrides'),'null'::jsonb);")
          await options.afterRead?.(); return { data, error: null }
        } }
      },
      async rpc(name, args) {
        assert.equal(name, "compare_and_swap_spc_supplier_store"); captured = args
        const writer = await f.session(`supplier-write-${randomUUID()}`)
        try {
          await writer.begin()
          await writer.query(`do $$ begin perform set_config('request.headers',${literal(JSON.stringify(headers))},true); end $$;`)
          const data = await writer.one(call(args)); await writer.query("commit;")
          if (lost) { lost = false; throw new Error("Injected acknowledgement lost after commit") }
          return { data, error: null }
        } catch (error) { return { data: null, error: nativeSpcPostgrestError(error) } }
        finally { await writer.close() }
      },
    }) })
  return { ...route, captured: () => captured }
}
const versions = async route => (await route.get()).body.records.find(row => row.key === "SYNTHETICALPHA").editVersions
const details = (expectedVersions, extra = {}) => ({ action: "save", supplier: { key: "SYNTHETICALPHA", name: "SYNTHETIC ALPHA", info: { paymentTerms: "30", qualityClaimBar: "", supplierTrader: "", availableGrade: "", foBdn: "", goBdn: "" }, expectedVersions, requestId: randomUUID(), ...extra } })
const contacts = expectedVersions => ({ action: "save-contacts", contacts: { supplierKey: "SYNTHETICALPHA", contacts: [{ id: "synthetic-person", role: "sales", name: "SYNTHETIC PERSON", mobile: "synthetic-number" }], expectedVersions, requestId: randomUUID() } })

test("native actual supplier API preserves edits, atomic audit and backup fence", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(spcSupplierFixtureSql())
  t.afterEach(async () => { await Promise.all(f.sessions.filter(client => client !== f.owner).map(client => client.close())) })
  try {
    await t.test("first-row held race rebases unrelated sections without losing either write", async () => {
      await reset(f); const expected = await versions(app(f))
      let release, readCount = 0; const held = new Promise(resolve => { release = resolve })
      const afterRead = async () => { if (++readCount <= 2) { if (readCount === 2) release(); await held } }
      const a = app(f, { afterRead }), b = app(f, { afterRead })
      const result = await Promise.all([a.patch(details(expected)), b.patch(contacts(expected))])
      assert.deepEqual(result.map(row => row.status), [200, 200], JSON.stringify(result))
      const after = await state(f); assert.equal(after.store[0].payload.records[0].info.paymentTerms, "30")
      assert.equal(after.store[0].payload.contacts[0].contacts.length, 1); assert.equal(after.audit.length, 2); assert.equal(after.fence.length, 2)
    })
    await t.test("same-section stale save is rejected with no extra audit or fence", async () => {
      await reset(f); const route = app(f), expected = await versions(route)
      assert.equal((await route.patch(details(expected))).status, 200); const before = await state(f)
      assert.equal((await route.patch(details(expected, { info: { ...details(expected).supplier.info, paymentTerms: "90" } }))).status, 409)
      assert.deepEqual(await state(f), before)
    })
    await t.test("native JSONB key reordering is acknowledged; lost response replay is read-only", async () => {
      await reset(f); const route = app(f, { loseResponse: true }), payload = details(await versions(route))
      assert.equal((await route.patch(payload)).status, 500); const before = await state(f)
      const retry = await route.patch(payload); assert.equal(retry.status, 200, JSON.stringify(retry)); assert.equal(retry.body.mutation.replayed, true)
      assert.deepEqual(await state(f), before)
      assert.equal((await route.patch({ ...payload, supplier: { ...payload.supplier, name: "MISMATCHED INTENT" } })).status, 409)
      assert.deepEqual(await state(f), before)
    })
    for (const fault of ["exception", "suppress", "mutate"]) await t.test(`audit ${fault} rolls back supplier data and backup epoch`, async () => {
      await reset(f); const route = app(f), payload = details(await versions(route))
      await f.owner.query(`create or replace function public.supplier_audit_fault() returns trigger language plpgsql as $$ begin
        ${fault === "exception" ? "raise exception 'Injected audit error';" : fault === "suppress" ? "return null;" : "new.after_row='{}'::jsonb;return new;"} end $$;
        create trigger supplier_audit_fault before insert on public.audit_logs for each row execute function public.supplier_audit_fault();`)
      const before = await state(f), result = await route.patch(payload)
      assert.equal(result.status, fault === "exception" ? 500 : 409, JSON.stringify(result)); assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger supplier_audit_fault on public.audit_logs;")
    })
    for (const [field, expression] of [["operation", "'DELETE'"], ["changed_fields", "array['not-the-change']::text[]"],
      ["actor_source", "'db'"], ["actor_name", "'WRONG AUDIT NAME'"]]) await t.test(`altered audit ${field} is rejected with full rollback`, async () => {
      await reset(f); const route = app(f), payload = details(await versions(route))
      await f.owner.query(`create or replace function public.supplier_audit_fault() returns trigger language plpgsql as $$ begin new.${field}=${expression};return new;end $$;
        create trigger supplier_audit_fault before insert on public.audit_logs for each row execute function public.supplier_audit_fault();`)
      const before = await state(f); assert.equal((await route.patch(payload)).status, 409); assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger supplier_audit_fault on public.audit_logs;")
    })
    for (const operation of ["insert", "update"]) await t.test(`suppressed supplier ${operation} cannot produce a false success or audit`, async () => {
      await reset(f); const route = app(f)
      if (operation === "update") assert.equal((await route.patch(details(await versions(route)))).status, 200)
      const payload = details(await versions(route), { info: { ...details({}).supplier.info, paymentTerms: "60" } })
      await f.owner.query(`create or replace function public.supplier_store_fault() returns trigger language plpgsql as $$ begin return null;end $$;
        create trigger supplier_store_fault before ${operation} on public.office_calendar_store for each row execute function public.supplier_store_fault();`)
      const before = await state(f); assert.equal((await route.patch(payload)).status, 409); assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger supplier_store_fault on public.office_calendar_store;")
    })
    await t.test("rename/delete protect every section, preserve tombstones, and reject occupied targets", async () => {
      await reset(f); const route = app(f), initial = await versions(route)
      assert.equal((await route.patch(contacts(initial))).status, 200)
      assert.equal((await route.patch(details(initial, { name: "SYNTHETIC RENAMED" }))).status, 409)
      const latest = await versions(route), before = await state(f)
      assert.equal((await route.patch(details(latest, { name: "SYNTHETIC BETA" }))).status, 409); assert.deepEqual(await state(f), before)
      const renamed = await route.patch(details(latest, { name: "SYNTHETIC RENAMED" })); assert.equal(renamed.status, 200)
      const record = renamed.body.records.find(row => row.key === "SYNTHETICRENAMED")
      assert.equal(record.contacts.length, 1)
      assert.equal((await route.patch({ action: "delete", key: record.key, expectedVersions: record.editVersions, requestId: randomUUID() })).status, 200)
      const after = await state(f); assert.equal(after.store[0].payload.records.filter(row => row.deleted).length, 2)
      assert.equal(after.store[0].payload.contacts.length, 0)
    })
    await t.test("old clients, malformed collections and optional-source outages cannot clear records", async () => {
      await reset(f); const route = app(f, { optionalUnavailable: true }), expected = await versions(route), before = await state(f)
      assert.equal((await route.patch(details(undefined))).status, 409)
      assert.equal((await route.patch(contacts(expected))).status, 409)
      assert.equal((await route.patch({ action: "save-barges", barges: { supplierKey: "SYNTHETICALPHA", barges: null, expectedVersions: expected, requestId: randomUUID() } })).status, 400)
      assert.deepEqual(await state(f), before)
    })
    await t.test("actual workbook-backed fleet and contacts survive renamed key and reload", async () => {
      await reset(f); const route = app(f, { sheetChildren: true })
      const original = (await route.get()).body.records.find(row => row.key === "SYNTHETICALPHA")
      assert.equal(original.barges.length, 1); assert.equal(original.contacts.length, 1)
      const renamed = await route.patch(details(original.editVersions, { name: "SYNTHETIC RENAMED" }))
      assert.equal(renamed.status, 200, JSON.stringify(renamed))
      const fresh = (await route.get()).body.records.find(row => row.key === "SYNTHETICRENAMED")
      const dataOnly = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => field !== "source")))
      assert.deepEqual(dataOnly(fresh.barges), dataOnly(original.barges)); assert.deepEqual(dataOnly(fresh.contacts), dataOnly(original.contacts))
    })
    await t.test("existing legacy NULL payload is not mistaken for a missing row", async () => {
      await reset(f); await f.owner.query("alter table public.office_calendar_store alter column payload drop not null; insert into public.office_calendar_store(key,payload) values('spc-supplier-overrides',null);")
      const route = app(f); const result = await route.patch(details(await versions(route)))
      assert.equal(result.status, 200, JSON.stringify(result)); assert.equal((await state(f)).audit[0].operation, "UPDATE")
      await f.owner.query("alter table public.office_calendar_store alter column payload set not null;")
    })
    await t.test("RPC is service-only invoker with empty search path and validates trusted actor/shape", async () => {
      const metadata = await f.owner.one("select jsonb_build_object('definer',prosecdef,'config',proconfig,'anon',has_function_privilege('anon',oid,'execute'),'auth',has_function_privilege('authenticated',oid,'execute'),'service',has_function_privilege('service_role',oid,'execute')) from pg_proc where oid='public.compare_and_swap_spc_supplier_store(jsonb,jsonb,boolean,text,uuid,text)'::regprocedure;")
      assert.deepEqual(metadata, { definer: false, config: ['search_path=""'], anon: false, auth: false, service: true })
      const source = app(f), expected = await versions(source); assert.equal((await source.patch(details(expected))).status, 200)
      const args = source.captured()
      for (const role of ["anon", "authenticated"]) {
        const denied = await f.session(`supplier-denied-${role}`, false)
        await assert.rejects(denied.query(`set role ${role}; ${call(args)}`), error => error.code === "42501")
      }
      const untrusted = await f.session("supplier-untrusted")
      await assert.rejects(untrusted.query(call(args)), error => error.code === "42501")
      const malformed = await f.session("supplier-malformed")
      await assert.rejects(malformed.query(call({ ...args, p_payload: { ...args.p_payload, contacts: null } })), error => error.code === "22023")
    })
  } finally { await f.close() }
})
