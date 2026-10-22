import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { spcSupplierFixtureSql } from "./fixtures/spc-supplier-sql.mjs"
import { supplierActor } from "./fixtures/spc-supplier-api.mjs"
import { expectedVersion, users } from "./fixtures/spc-stem-api.mjs"
import { cases } from "./fixtures/spc-write-conflicts-api.mjs"

const migration = readFileSync(new URL("../supabase/migrations/20261022111715_nonretryable_spc_supplier_stem_fixture_conflicts.sql", import.meta.url), "utf8")
const baselineOnly = process.env.SPC_WRITE_BASELINE_ONLY === "1"
const signatures = ["compare_and_swap_spc_supplier_store(jsonb,jsonb,boolean,text,uuid,text)", "stem_spc_enquiry_with_fixture(uuid,text,timestamptz,uuid,text,text,jsonb)", "update_spc_fixture_with_enquiry(uuid,text,timestamptz,text,text,jsonb,text)"]
const json = value => value == null ? "null" : `${literal(JSON.stringify(value))}::jsonb`
const catalog = f => f.owner.one(`select jsonb_agg(jsonb_build_object('oid',p.oid,'name',p.proname,'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef,'volatility',p.provolatile,'parallel',p.proparallel,'body',p.prosrc,'definition',pg_get_functiondef(p.oid)) order by p.proname) from pg_proc p where p.oid in (${signatures.map(name => `${literal("public." + name)}::regprocedure`).join(",")});`)
const state = f => f.owner.one(`select jsonb_build_object(
  'store',(select coalesce(jsonb_agg(to_jsonb(t) order by key),'[]') from public.office_calendar_store t),
  'enquiries',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_enquiries t),
  'fixtures',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.spc_fixtures t),
  'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
  'epochs',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t));`)
const store = { records: [], barges: [], contacts: [], receipts: [] }
const supplierCall = (exists = false, expected = null, payload = store) => `select public.compare_and_swap_spc_supplier_store(${json(expected)},${json(payload)},${exists},${literal(supplierActor.username)},'${randomUUID()}','save')`
function stemArgs(id) {
  return { id, requestId: randomUUID(), expected: expectedVersion, supplier: users[1].username, notes: "SYNTHETIC STEM",
    fixture: { enquiry_id: id, fixture_status: "pending", fixture_date: "2026-10-20", supplier_trader_user_id: users[1].id, supplier_trader_username: users[1].username,
      buyer_trader_user_id: supplierActor.userId, buyer_trader_username: supplierActor.username, account: "HONG KONG", vessel_name: "SYNTHETIC VESSEL", vlsfo: "500", price: "700", barging: "10" } }
}
const stemCall = a => `select * from public.stem_spc_enquiry_with_fixture('${a.id}',${literal(supplierActor.username)},${literal(a.expected)},'${a.requestId}',${literal(a.supplier)},${literal(a.notes)},${json(a.fixture)})`
const fixtureCall = (row, action = "save", patch = {}) => `select public.update_spc_fixture_with_enquiry('${row.id}',${literal(users[1].username)},${literal(patch.expected || row.updated_at)},${literal(row.fixture_status)},${literal(action)},${json(action === "delete" ? null : row)},${literal("NEW SUPPLIER")})`
async function seed(f) {
  const id = randomUUID()
  await f.owner.query(`insert into public.spc_enquiries(id,enquiry_number,title,status,notes,created_by_username,created_by_display_name,updated_at)
    values('${id}','SPC-${id}','SYNTHETIC VESSEL','sent','SYNTHETIC',${literal(supplierActor.username)},'Synthetic Editor','${expectedVersion}');`)
  return stemArgs(id)
}
async function attempt(f, sql, supplier = false) {
  const client = await f.session(`conflict-${randomUUID()}`)
  try {
    await client.begin()
    const actor = supplier ? users[1] : { username: supplierActor.username, id: supplierActor.userId }
    await client.query(`do $$ begin perform set_config('request.headers',${literal(JSON.stringify({"x-bunker-admin-user":`spc:${actor.username}`,"x-bunker-audit-actor-user-id":actor.id,"x-bunker-admin-page-id":"spc-synthetic-conflicts","x-bunker-audit-action":"synthetic-conflict-verification"}))},true); end $$;`)
    const result = await client.one(`select private.capture_spc_conflict(${literal(sql)});`)
    await client.query("commit;")
    return result
  } finally { await client.close() }
}
async function fault(f, table, operation, body) {
  await f.owner.query(`create or replace function public.synthetic_spc_write_fault() returns trigger language plpgsql as $$ begin ${body} end $$;
    create trigger synthetic_spc_write_fault before ${operation} on public.${table} for each row execute function public.synthetic_spc_write_fault();`)
  return () => f.owner.query(`drop trigger synthetic_spc_write_fault on public.${table};`)
}
async function refusal(f, sql, tuple, actor = false) {
  const before = await state(f), result = await attempt(f, sql, actor)
  assert.deepEqual(await state(f), before, "failed aggregate rolls back business rows, receipts, audit and backup epochs")
  assert.deepEqual(result, { code: "P0001", message: tuple[1], details: tuple[2] })
}

test("native PostgreSQL 17.6 SPC intentional refusals are non-retryable with unchanged atomic boundaries", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(spcSupplierFixtureSql())
  try {
    const original = await catalog(f)
    if (!baselineOnly) await f.owner.query(migration)
    await f.owner.query(`create function private.capture_spc_conflict(statement text) returns jsonb language plpgsql security invoker set search_path='' as $$
      declare state text; message text; detail text; begin execute statement; return '{"ok":true}'::jsonb;
      exception when others then get stacked diagnostics state=returned_sqlstate,message=message_text,detail=pg_exception_detail;
      return jsonb_build_object('code',state,'message',message,'details',detail); end $$;
      grant execute on function private.capture_spc_conflict(text) to service_role;`)
    await t.test("catalog identities, settings, ACLs and all non-error source bytes are preserved", async () => {
      const current = await catalog(f)
      assert.equal((current.map(row => row.body).join("\n").match(/errcode\s*=\s*'P0001'/g) || []).length, 16)
      for (const old of original) {
        const now = current.find(row => row.name === old.name)
        const normalized = now.body.replace(/errcode\s*=\s*'P0001', message\s*=\s*'([^']+)', detail\s*=\s*'([^']+)'/g, (match, message, detail) => {
          const oldRaise = old.body.match(new RegExp(`errcode\\s*=\\s*'40001', message\\s*=\\s*'${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'(?:, detail\\s*=\\s*'[^']+')?`))?.[0]
          assert.ok(oldRaise, detail); return oldRaise
        })
        assert.deepEqual({ ...now, body: old.body, definition: old.definition }, old)
        assert.equal(normalized, old.body)
        assert.equal(now.definer, false); assert.deepEqual(now.config, ['search_path=""'])
      }
    })
    await t.test("missing-row supplier insertion contention", async () => {
      const clean = await fault(f,"office_calendar_store","insert","return null;")
      try { await refusal(f,supplierCall(),cases[0]) } finally { await clean() }
    })
    await t.test("existing supplier payload baseline contention", async () => {
      await f.owner.query(`insert into public.office_calendar_store(key,payload) values('spc-supplier-overrides',${json(store)}) on conflict(key) do update set payload=excluded.payload;`)
      await refusal(f,supplierCall(true,{...store,other:"stale"}),cases[0])
    })
    await t.test("suppressed supplier update is unconfirmed, not CAS contention", async () => {
      const clean=await fault(f,"office_calendar_store","update","return null;")
      try { await refusal(f,supplierCall(true,store),cases[1]) } finally { await clean() }
    })
    await t.test("altered supplier RETURNING payload rolls back", async () => {
      const clean=await fault(f,"office_calendar_store","update","new.payload='{}'::jsonb; return new;")
      try { await refusal(f,supplierCall(true,store),cases[1]) } finally { await clean() }
    })
    await t.test("suppressed supplier audit rolls back store and epoch", async () => {
      const clean=await fault(f,"audit_logs","insert","return null;")
      try { await refusal(f,supplierCall(true,store),cases[2]) } finally { await clean() }
    })
    await t.test("same STEM receipt with changed intent is a baseline conflict", async () => {
      const a=await seed(f);assert.deepEqual(await attempt(f,stemCall(a)),{ok:true})
      await refusal(f,stemCall({...a,supplier:users[2].username}),cases[3])
    })
    await t.test("same STEM receipt cannot recreate a deliberately removed fixture", async () => {
      const a=await seed(f);assert.deepEqual(await attempt(f,stemCall(a)),{ok:true})
      await f.owner.query(`delete from public.spc_fixtures where enquiry_id='${a.id}';`)
      await refusal(f,stemCall(a),cases[4])
    })
    await t.test("stale STEM source version", async () => {
      const a=await seed(f);await refusal(f,stemCall({...a,expected:"2026-10-01T00:00:00Z"}),cases[5])
    })
    await t.test("pre-existing STEM fixture is not overwritten", async () => {
      const a=await seed(f)
      await f.owner.query(`insert into public.spc_fixtures(enquiry_id,supplier_trader_username,supplier_trader_display_name,buyer_trader_username,buyer_trader_display_name) values('${a.id}',${literal(users[1].username)},'Synthetic Supplier',${literal(supplierActor.username)},'Synthetic Editor');`)
      await refusal(f,stemCall(a),cases[6])
    })
    for (const [table, operation, tuple] of [["spc_enquiries","update",cases[7]],["spc_fixtures","insert",cases[8]]]) await t.test(`suppressed ${table} STEM write rolls back receipt and aggregate`,async()=>{
      const a=await seed(f),clean=await fault(f,table,operation,"return null;")
      try{await refusal(f,stemCall(a),tuple)}finally{await clean()}
      assert.deepEqual(await attempt(f,stemCall(a)),{ok:true},"same durable request UUID remains available after rollback")
      const committed=await state(f);assert.deepEqual(await attempt(f,stemCall(a)),{ok:true});assert.deepEqual(await state(f),committed,"committed replay remains read-only")
    })
    await t.test("missing fixture parent is a baseline conflict",async()=>{
      await refusal(f,fixtureCall({id:randomUUID(),updated_at:expectedVersion,fixture_status:"completed"},"delete"),cases[9],true)
    })
    await t.test("stale fixture version cannot overwrite saved prices",async()=>{
      const a=await seed(f);await attempt(f,stemCall(a));const row=(await state(f)).fixtures.find(row=>row.enquiry_id===a.id)
      await refusal(f,fixtureCall(row,"save",{expected:"2026-10-01T00:00:00Z"}),cases[10],true)
    })
    for (const [label,table,operation,action,tuple] of [["delete","spc_fixtures","delete","delete",cases[11]],["update","spc_fixtures","update","save",cases[12]],["source supplier","spc_enquiries","update","save",cases[13]]]) await t.test(`suppressed fixture ${label} has complete rollback`,async()=>{
      const a=await seed(f);assert.deepEqual(await attempt(f,stemCall(a)),{ok:true});const row=(await state(f)).fixtures.find(row=>row.enquiry_id===a.id)
      const clean=await fault(f,table,operation,"return null;")
      try{await refusal(f,fixtureCall(row,action),tuple,true)}finally{await clean()}
    })
    await t.test("a genuine unclassified engine SQLSTATE 40001 is not relabelled by an RPC",async()=>{
      const a=await seed(f),clean=await fault(f,"spc_fixtures","insert","raise exception using errcode='40001',message='Synthetic engine serialization refusal';")
      const before=await state(f)
      try{assert.deepEqual(await attempt(f,stemCall(a)),{code:"40001",message:"Synthetic engine serialization refusal",details:""});assert.deepEqual(await state(f),before)}finally{await clean()}
    })
    await t.test("baseline drift fails before replacing any function or changing business data",async()=>{
      const installed=await catalog(f)
      await f.owner.query(original.map(row=>row.definition+";").join("\n"))
      const drift=original[0].definition.replace("declare","declare -- synthetic reviewed-source drift")
      await f.owner.query(drift+";")
      const before=await catalog(f),business=await state(f),client=await f.session("migration-drift",false)
      await assert.rejects(client.query(`begin;${migration}commit;`),error=>error.code==="55000")
      assert.deepEqual(await catalog(f),before);assert.deepEqual(await state(f),business)
      await f.owner.query(installed.map(row=>row.definition+";").join("\n"))
    })
  } finally { await f.close() }
})
