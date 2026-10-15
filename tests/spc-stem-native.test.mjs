import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { spcStemFixtureSql } from "./fixtures/spc-stem-sql.mjs"
import { createSpcStemRoute, enquiry, expectedVersion, stemPayload, session, users } from "./fixtures/spc-stem-api.mjs"

const state = f => f.owner.one(`select jsonb_build_object(
  'enquiries',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_enquiries t),
  'fixtures',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_fixtures t),
  'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
  'epochs',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t));`)
async function seed(f, ownerUsername = session.username, notes = enquiry.notes) {
  const id = randomUUID()
  await f.owner.query(`insert into public.spc_enquiries(id,enquiry_number,title,vessel_name,port,product,quantity,delivery_date,status,notes,created_by_username,created_by_display_name,updated_at)
    values('${id}','SPC-${id}','SYNTHETIC VESSEL','SYNTHETIC VESSEL','Singapore','VLSFO','500','2026-10-20','sent',${literal(notes)},${literal(ownerUsername)},${literal(session.displayName)},'${expectedVersion}');`)
  return id
}
const call = args => `select coalesce(jsonb_agg(to_jsonb(result)),'[]') from public.stem_spc_enquiry_with_fixture(
  ${literal(args.p_enquiry_id)},${literal(args.p_actor_username)},${literal(args.p_expected_updated_at)},${literal(args.p_request_id)},${literal(args.p_supplier_username)},
  ${args.p_notes == null ? "null" : literal(args.p_notes)},${args.p_fixture == null ? "null" : `${literal(JSON.stringify(args.p_fixture))}::jsonb`}
) result;`
async function trustedBegin(client) {
  await client.begin()
  const headers = {
    "x-bunker-admin-user": `spc:${session.username}`, "x-bunker-admin-display-name": session.displayName,
    "x-bunker-audit-actor-user-id": session.userId, "x-bunker-admin-page-id": "spc-buyer-enquiries",
    "x-bunker-audit-action": "set-enquiry-stem",
  }
  await client.query(`do $$ begin perform set_config('request.headers',${literal(JSON.stringify(headers))},true); end $$;`)
}
function nativeApp(f, options = {}) {
  const connection = f.session(`stem-route-${randomUUID()}`)
  let rpcCalls = 0, captured
  const app = createSpcStemRoute({
    userLookupError: options.userLookupError,
    createClient: headers => ({
      from(table) {
        assert.equal(table, "spc_enquiries")
        const filters = []
        let action = "read", payload
        const query = {
          select() { return query },
          eq(key, value) { assert.ok(["id", "status", "updated_at"].includes(key)); filters.push([key, value]); return query },
          update(value) { action = "update"; payload = value; return query },
          delete() { action = "delete"; return query },
          async single() {
            const client = await connection
            const where = filters.map(([key, value]) => `${key}=${literal(value)}`).join(" and ")
            if (action === "read") {
              const data = await client.one(`select to_jsonb(t) from public.spc_enquiries t where ${where};`)
              await options.afterRead?.()
              return { data, error: null }
            }
            await client.begin()
            await client.query(`do $$ begin perform set_config('request.headers',${literal(JSON.stringify(headers))},true); end $$;`)
            const mutation = action === "delete"
              ? `delete from public.spc_enquiries t where ${where} returning to_jsonb(t) as row`
              : `update public.spc_enquiries t set ${Object.entries(payload).map(([key, value]) => {
                  assert.ok(["status", "notes", "updated_at", "supplier_name"].includes(key)); return `${key}=${literal(value)}`
                }).join(",")} where ${where} returning to_jsonb(t) as row`
            const changed = await client.one(`with changed as (${mutation}) select coalesce(jsonb_agg(row),'[]') from changed;`)
            // PostgREST's singular response check condemns a zero-row mutation
            // transaction rather than committing its statement-level triggers.
            if (changed.length !== 1) {
              await client.query("rollback;")
              return { data: null, error: { code: "PGRST116", message: "Singular response required" } }
            }
            await client.query("commit;")
            return { data: changed[0], error: null }
          },
        }
        return query
      },
      async rpc(name, args) {
        assert.equal(name, "stem_spc_enquiry_with_fixture"); captured = args; rpcCalls += 1
        const client = await connection
        await client.begin()
        await client.query(`do $$ begin perform set_config('request.headers',${literal(JSON.stringify(headers))},true); end $$;`)
        try {
          const data = await client.one(call(args))
          await client.query("commit;")
          if (options.loseResponse) throw new Error("Injected response lost after commit")
          return { data, error: null }
        } catch (error) { return { data: null, error: { code: error.code, message: error.message } } }
      },
    }),
  })
  return { ...app, connection, rpcCalls: () => rpcCalls, captured: () => captured }
}

test("native PostgreSQL 17.6 and actual STEM API maintain enquiry/fixture atomicity", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(spcStemFixtureSql())
  t.afterEach(async () => { await Promise.all(f.sessions.filter(client => client !== f.owner).map(client => client.close())) })
  try {
    await t.test("actual API user lookup outage leaves the sent enquiry and all audit/backup state unchanged", async () => {
      const id = await seed(f), before = await state(f)
      const app = nativeApp(f, { userLookupError: new Error("Injected user lookup outage") })
      assert.equal((await app.patch(stemPayload({ id }))).status, 500)
      assert.equal(app.rpcCalls(), 0)
      assert.deepEqual(await state(f), before)
    })
    await t.test("new write acknowledgements preserve existing case-insensitive owner matching", async () => {
      const id = await seed(f, session.username.toUpperCase())
      const response = await nativeApp(f).patch(stemPayload({ id }))
      assert.equal(response.status, 200, JSON.stringify(response))
      assert.equal(response.body.enquiry.createdByUsername, session.username.toUpperCase())
    })
    await t.test("fresh fixtures snapshot enquiry IMO and completed retry preserves the saved snapshot", async () => {
      const notes = `${enquiry.notes}\n\n---SPC_META---\n${JSON.stringify({ imo: "9730878" })}`
      const id = await seed(f, session.username, notes), payload = stemPayload({ id, stemRequestId: randomUUID() })
      const created = await nativeApp(f).patch(payload)
      assert.equal(created.status, 200, JSON.stringify(created))
      const fixture = (await state(f)).fixtures.find(row => row.enquiry_id === id)
      assert.equal(fixture.vessel_imo, "9730878")
      await f.owner.query(`update public.spc_fixtures set fixture_status='completed',price='VLSFO: 777.25',commission='KEEP',completed_at=now(),completed_by_username='synthetic-completer' where id='${fixture.id}';`)
      const beforeRetry = await state(f)
      const retry = await nativeApp(f, { userLookupError: new Error("Retry must not rebuild an existing fixture") }).patch(payload)
      assert.equal(retry.status, 200, JSON.stringify(retry))
      assert.deepEqual(await state(f), beforeRetry)
      const noImoId = await seed(f)
      assert.equal((await nativeApp(f).patch(stemPayload({ id: noImoId, stemRequestId: randomUUID() }))).status, 200)
      assert.equal((await state(f)).fixtures.find(row => row.enquiry_id === noImoId).vessel_imo, null)
    })
    await t.test("fixture failure after enquiry UPDATE rolls back source, fixture, audit and backup epoch together", async () => {
      const id = await seed(f)
      await f.owner.query(`create function public.fail_stem_fixture() returns trigger language plpgsql as $$ begin
        if new.enquiry_id='${id}'::uuid then raise exception 'Injected late fixture failure'; end if; return new; end $$;
        create trigger fail_stem_fixture before insert on public.spc_fixtures for each row execute function public.fail_stem_fixture();`)
      const before = await state(f), app = nativeApp(f)
      const response = await app.patch(stemPayload({ id }))
      assert.equal(response.status, 500)
      assert.match(response.body.message, /Injected late fixture failure/)
      assert.equal(app.rpcCalls(), 1)
      assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger fail_stem_fixture on public.spc_fixtures;")
    })
    for (const kind of ["enquiry-update", "fixture-insert"]) await t.test(`suppressed ${kind} rolls back STEM/source/receipt/audit/backup and preserves the request UUID for retry`, async () => {
      const id = await seed(f), payload = stemPayload({ id, stemRequestId: randomUUID() })
      const table = kind === "enquiry-update" ? "spc_enquiries" : "spc_fixtures"
      const operation = kind === "enquiry-update" ? "update" : "insert"
      const field = kind === "enquiry-update" ? "id" : "enquiry_id"
      await f.owner.query(`create or replace function public.suppress_stem_write() returns trigger language plpgsql as $$ begin
        if new.${field}='${id}'::uuid then return null; end if; return new; end $$;
        create trigger suppress_stem_write before ${operation} on public.${table} for each row execute function public.suppress_stem_write();`)
      const before = await state(f)
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await nativeApp(f).patch(payload)
        assert.equal(response.status, 409, JSON.stringify(response))
        assert.match(response.body.message, /STEM (?:enquiry was not saved|fixture was not created)/)
        assert.deepEqual(await state(f), before)
      }
      await f.owner.query(`drop trigger suppress_stem_write on public.${table};`)
      const saved = await nativeApp(f).patch(payload)
      assert.equal(saved.status, 200, JSON.stringify(saved))
      const committed = await state(f), row = committed.enquiries.find(row => row.id === id)
      assert.equal(row.stem_request_id, payload.stemRequestId)
      assert.equal(row.status, "quoted")
      assert.equal(committed.fixtures.filter(row => row.enquiry_id === id).length, 1)
      const retry = await nativeApp(f, { userLookupError: new Error("Retry must be read-only") }).patch(payload)
      assert.equal(retry.status, 200, JSON.stringify(retry))
      assert.deepEqual(await state(f), committed)
    })
    await t.test("lost-response retry is read-only and preserves a subsequently completed fixture", async () => {
      const id = await seed(f), payload = stemPayload({ id })
      const lost = nativeApp(f, { loseResponse: true })
      assert.equal((await lost.patch(payload)).status, 500)
      let current = await state(f)
      assert.equal(current.enquiries.find(row => row.id === id).status, "quoted")
      const fixture = current.fixtures.find(row => row.enquiry_id === id)
      assert.ok(fixture)
      const logs = current.audit.filter(row => row.record_pk.id === id || row.record_pk.id === fixture.id)
      assert.equal(logs.filter(row => row.request_context.action === "set-enquiry-stem").length, 2)
      await f.owner.query(`update public.spc_fixtures set fixture_status='completed',price='VLSFO: 777.25',commission='KEEP',completed_at=now(),completed_by_username='synthetic-completer' where id='${fixture.id}';`)
      const beforeRetry = await state(f), retry = nativeApp(f, { userLookupError: new Error("Lookup must not run on retry") })
      const response = await retry.patch(payload)
      assert.equal(response.status, 200)
      assert.equal(response.body.enquiry.status, "quoted")
      assert.equal(retry.lookups(), 0)
      assert.deepEqual(await state(f), beforeRetry)
      const changedIntent = nativeApp(f)
      assert.equal((await changedIntent.patch({ ...payload, supplierTraderUsername: users[2].username })).status, 409)
      assert.deepEqual(await state(f), beforeRetry)
    })
    await t.test("stale source versions and existing completed fixtures cannot be overwritten", async () => {
      const staleId = await seed(f)
      await f.owner.query(`update public.spc_enquiries set title='CONCURRENT AMENDMENT' where id='${staleId}';`)
      const beforeStale = await state(f)
      assert.equal((await nativeApp(f).patch(stemPayload({ id: staleId }))).status, 409)
      assert.deepEqual(await state(f), beforeStale)
      const completedId = await seed(f)
      await f.owner.query(`insert into public.spc_fixtures(enquiry_id,fixture_status,supplier_trader_username,supplier_trader_display_name,buyer_trader_username,buyer_trader_display_name,price)
        values('${completedId}','completed','supplier@example.test','Synthetic Supplier','buyer@example.test','Synthetic Buyer','DO NOT TOUCH');`)
      const beforeCompleted = await state(f)
      assert.equal((await nativeApp(f).patch(stemPayload({ id: completedId }))).status, 409)
      assert.deepEqual(await state(f), beforeCompleted)
    })
    await t.test("concurrent different STEM operations serialize, create one fixture and reject the stale loser", async () => {
      const id = await seed(f), preparation = nativeApp(f, { loseResponse: true })
      // Capture real API parameters from an independent successful operation,
      // then use a fresh source for the controlled interleaving below.
      await preparation.patch(stemPayload({ id }))
      const args = preparation.captured()
      const heldId = await seed(f)
      args.p_enquiry_id = heldId; args.p_fixture.enquiry_id = heldId; args.p_request_id = randomUUID()
      const writer = await f.session("held-first-stem"), observer = await f.session("stem-observer")
      await trustedBegin(writer)
      await writer.one(call(args))
      const waiter = nativeApp(f)
      const pending = waiter.patch(stemPayload({ id: heldId, stemRequestId: randomUUID(), supplierTraderUsername: users[2].username }))
      const waiterConnection = await waiter.connection
      await waitForBlock(observer, waiterConnection, writer)
      await writer.query("commit;")
      assert.equal((await pending).status, 409)
      const after = await state(f)
      assert.equal(after.fixtures.filter(row => row.enquiry_id === heldId).length, 1)
      assert.equal(after.fixtures.find(row => row.enquiry_id === heldId).supplier_trader_username, users[1].username)
    })
    await t.test("concurrent same-operation retry waits and returns success without duplicate writes", async () => {
      const id = await seed(f), app = nativeApp(f)
      await app.patch(stemPayload({ id }))
      const args = app.captured(), heldId = await seed(f)
      args.p_enquiry_id = heldId; args.p_fixture.enquiry_id = heldId; args.p_request_id = randomUUID()
      const writer = await f.session("held-idempotent-stem"), observer = await f.session("idempotent-observer")
      await trustedBegin(writer); await writer.one(call(args))
      const waiter = nativeApp(f)
      const pending = waiter.patch(stemPayload({ id: heldId, stemRequestId: args.p_request_id }))
      await waitForBlock(observer, await waiter.connection, writer)
      await writer.query("commit;")
      const committed = await state(f)
      assert.equal((await pending).status, 200)
      assert.deepEqual(await state(f), committed)
      assert.equal(committed.fixtures.filter(row => row.enquiry_id === heldId).length, 1)
    })
    await t.test("delayed LOST, POSTPONE and CANCEL requests cannot overwrite or delete a new STEM", async () => {
      for (const outcome of ["lost", "postpone", "cancel"]) {
        const id = await seed(f)
        let release, read
        const held = new Promise(resolve => { release = resolve })
        const snapshotTaken = new Promise(resolve => { read = resolve })
        const stale = nativeApp(f, { afterRead: async () => { read(); await held } })
        const pending = stale.patch(stemPayload({ id, outcome, lostReason: "PRICE" }))
        await snapshotTaken
        assert.equal((await nativeApp(f).patch(stemPayload({ id }))).status, 200)
        const committed = await state(f)
        release()
        assert.equal((await pending).status, 409)
        assert.deepEqual(await state(f), committed)
        assert.equal(committed.enquiries.find(row => row.id === id).status, "quoted")
        assert.equal(committed.fixtures.filter(row => row.enquiry_id === id).length, 1)
        await (await stale.connection).close()
      }
    })
    await t.test("legacy fixture notes use an exact sent-source version, and a subsequent fresh STEM inherits them", async () => {
      const id = await seed(f), before = await state(f), app = nativeApp(f)
      const payload = { id, mode: "fixture", expectedUpdatedAt: expectedVersion,
        fixture: { supplier: "SYNTHETIC SUPPLIER", eta: "20 OCT", vlsfo: "500", price: "700" } }
      assert.equal((await app.patch({ ...payload, expectedUpdatedAt: undefined })).status, 400)
      assert.deepEqual(await state(f), before)
      const saved = await app.patch(payload)
      assert.equal(saved.status, 200)
      assert.equal(saved.body.enquiry.status, "sent")
      assert.equal(saved.body.enquiry.meta.fixtureSupplier, "SYNTHETIC SUPPLIER")
      const current = await state(f)
      assert.equal(current.fixtures.filter(row => row.enquiry_id === id).length, 0)
      assert.equal((await app.patch(payload)).status, 409)
      assert.deepEqual(await state(f), current)
      const stem = await nativeApp(f).patch(stemPayload({ id, expectedUpdatedAt: saved.body.enquiry.updatedAt }))
      assert.equal(stem.status, 200)
      const committed = await state(f), fixture = committed.fixtures.find(row => row.enquiry_id === id)
      assert.equal(fixture.supplier_name, "SYNTHETIC SUPPLIER")
      assert.equal(fixture.price, "700")
      assert.equal((await app.patch({ ...payload, expectedUpdatedAt: stem.body.enquiry.updatedAt })).status, 409)
      assert.deepEqual(await state(f), committed)
    })
    await t.test("a delayed legacy fixture-note request cannot erase newly committed STEM outcome metadata or receipts", async () => {
      const id = await seed(f)
      let release, read
      const held = new Promise(resolve => { release = resolve })
      const snapshotTaken = new Promise(resolve => { read = resolve })
      const stale = nativeApp(f, { afterRead: async () => { read(); await held } })
      const pending = stale.patch({ id, mode: "fixture", expectedUpdatedAt: expectedVersion,
        fixture: { supplier: "STALE SUPPLIER", vlsfo: "500", price: "700" } })
      await snapshotTaken
      assert.equal((await nativeApp(f).patch(stemPayload({ id }))).status, 200)
      const committed = await state(f)
      release()
      const result = await pending
      assert.equal(result.status, 409)
      assert.match(result.body.message, /Fixtures page for an existing STEM/)
      assert.deepEqual(await state(f), committed)
      const source = committed.enquiries.find(row => row.id === id)
      assert.ok(source.notes.includes("stemSupplierTraderUsername"))
      assert.ok(source.stem_request_id)
      assert.equal(committed.fixtures.filter(row => row.enquiry_id === id).length, 1)
    })
    await t.test("fixture-note edits that win first force an old-snapshot STEM to refresh rather than discard the edit", async () => {
      const id = await seed(f)
      let release, read
      const held = new Promise(resolve => { release = resolve })
      const snapshotTaken = new Promise(resolve => { read = resolve })
      const staleStem = nativeApp(f, { afterRead: async () => { read(); await held } })
      const pending = staleStem.patch(stemPayload({ id }))
      await snapshotTaken
      const edited = await nativeApp(f).patch({ id, mode: "fixture", expectedUpdatedAt: expectedVersion,
        fixture: { supplier: "SYNTHETIC SUPPLIER", vlsfo: "600", price: "701" } })
      assert.equal(edited.status, 200)
      const committed = await state(f)
      release()
      assert.equal((await pending).status, 409)
      assert.deepEqual(await state(f), committed)
      assert.equal(committed.enquiries.find(row => row.id === id).status, "sent")
      assert.equal(committed.fixtures.filter(row => row.enquiry_id === id).length, 0)
    })
    await t.test("a fixture-note database failure leaves source, receipts, audit and backup state unchanged", async () => {
      const id = await seed(f)
      await f.owner.query(`create function public.fail_fixture_note_edit() returns trigger language plpgsql as $$ begin
        if new.id='${id}'::uuid then raise exception 'Injected fixture-note failure'; end if; return new; end $$;
        create trigger fail_fixture_note_edit before update on public.spc_enquiries for each row execute function public.fail_fixture_note_edit();`)
      const before = await state(f), app = nativeApp(f)
      const result = await app.patch({ id, mode: "fixture", expectedUpdatedAt: expectedVersion,
        fixture: { supplier: "SYNTHETIC SUPPLIER", vlsfo: "500", price: "700" } })
      assert.equal(result.status, 500)
      assert.match(result.body.message, /Injected fixture-note failure/)
      assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger fail_fixture_note_edit on public.spc_enquiries;")
    })
    await t.test("the current amendment and reoffer transactions fail closed after a concurrent STEM", async () => {
      for (const action of ["amend", "reoffer"]) {
        const preparedId = await seed(f), preparation = nativeApp(f)
        await preparation.patch(stemPayload({ id: preparedId }))
        const id = await seed(f), args = preparation.captured()
        args.p_enquiry_id = id; args.p_fixture.enquiry_id = id; args.p_request_id = randomUUID()
        const writer = await f.session(`stem-before-${action}`), waiter = await f.session(`stale-${action}`), observer = await f.session(`${action}-observer`)
        await trustedBegin(writer); await writer.one(call(args)); await trustedBegin(waiter)
        const sql = action === "amend"
          ? `select public.amend_spc_enquiry_with_group_delivery('${id}',${literal(session.username)},'Synthetic Buyer','{"title":"STALE"}','STALE','[{"field":"vesselName"}]','STALE');`
          : `select public.reoffer_spc_enquiry_with_group_delivery('${id}',${literal(session.username)},'Synthetic Buyer','{"title":"STALE"}','STALE','{}','STALE','STALE');`
        const pending = waiter.query(sql).then(value => ({ value }), error => ({ error }))
        await waitForBlock(observer, waiter, writer)
        await writer.query("commit;")
        const committed = await state(f), response = await pending
        assert.match(response.error?.message || "", /Only (a sent|an active) enquiry can be (amended|reoffered)/)
        assert.deepEqual(await state(f), committed)
        await writer.close(); await observer.close(); await (await preparation.connection).close()
      }
    })
    await t.test("new STEM holds user eligibility through commit and rejects a deactivated supplier", async () => {
      const preparedId = await seed(f), preparation = nativeApp(f)
      await preparation.patch(stemPayload({ id: preparedId }))
      const id = await seed(f), args = preparation.captured()
      args.p_enquiry_id = id; args.p_fixture.enquiry_id = id; args.p_request_id = randomUUID()
      const writer = await f.session("active-user-stem"), deactivator = await f.session("deactivate-supplier"), observer = await f.session("user-eligibility-observer")
      await trustedBegin(writer); await writer.one(call(args))
      const pending = deactivator.query(`update public.spc_users set is_active=false where id='${users[1].id}';`)
      await waitForBlock(observer, deactivator, writer)
      await writer.query("commit;"); await pending
      const nextId = await seed(f), before = await state(f)
      assert.equal((await nativeApp(f).patch(stemPayload({ id: nextId }))).status, 400)
      assert.deepEqual(await state(f), before)
      await f.owner.query(`update public.spc_users set is_active=true where id='${users[1].id}';`)
      await writer.close(); await deactivator.close(); await observer.close(); await (await preparation.connection).close()
    })
    await t.test("RPC is service-only invoker, validates actor ownership, and rejects partial audit undo", async () => {
      const privileges = await f.owner.one(`select jsonb_build_object(
        'anon',has_function_privilege('anon','public.stem_spc_enquiry_with_fixture(uuid,text,timestamptz,uuid,text,text,jsonb)','execute'),
        'authenticated',has_function_privilege('authenticated','public.stem_spc_enquiry_with_fixture(uuid,text,timestamptz,uuid,text,text,jsonb)','execute'),
        'service',has_function_privilege('service_role','public.stem_spc_enquiry_with_fixture(uuid,text,timestamptz,uuid,text,text,jsonb)','execute'),
        'definer',(select prosecdef from pg_proc where oid='public.stem_spc_enquiry_with_fixture(uuid,text,timestamptz,uuid,text,text,jsonb)'::regprocedure));`)
      assert.deepEqual(privileges, { anon: false, authenticated: false, service: true, definer: false })
      const id = await seed(f), app = nativeApp(f)
      assert.equal((await app.patch(stemPayload({ id }))).status, 200)
      const before = await state(f)
      const log = before.audit.find(row => row.table_name === "spc_enquiries" && row.record_pk.id === id && row.request_context.action === "set-enquiry-stem")
      assert.ok(log)
      const undo = await f.session("reject-partial-stem-undo")
      await trustedBegin(undo)
      await undo.query(`select set_config('app.audit_undo_of_log_id','${log.id}',true);`)
      await assert.rejects(undo.query(`update public.spc_enquiries set status='sent' where id='${id}';`), error => error.code === "23514")
      assert.deepEqual(await state(f), before)
      const foreign = await f.session("reject-forged-stem-actor")
      await trustedBegin(foreign)
      await assert.rejects(foreign.one(call({ ...app.captured(), p_actor_username: "foreign@example.test" })), error => error.code === "42501")
      assert.deepEqual(await state(f), before)
    })
    await t.test("native dump/restore retains the retry receipt, fixture and audit evidence", async () => {
      const id = await seed(f), app = nativeApp(f)
      assert.equal((await app.patch(stemPayload({ id }))).status, 200)
      const original = await state(f), recovery = await f.dumpAndRestore()
      const restored = await state({ owner: recovery.owner })
      assert.deepEqual(restored, original)
      await trustedBegin(recovery.service)
      const result = await recovery.service.one(call({ ...app.captured(), p_fixture: null, p_notes: null }))
      await recovery.service.query("commit;")
      assert.equal(result[0].stem_request_id, app.captured().p_request_id)
      assert.deepEqual(await state({ owner: recovery.owner }), restored)
      assert.match(recovery.sha256, /^[a-f0-9]{64}$/)
    })
  } finally { await f.close() }
})
