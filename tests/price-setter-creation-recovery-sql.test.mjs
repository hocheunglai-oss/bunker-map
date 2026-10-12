import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import { setup } from "./fixtures/price-setter-sql.mjs"
import { priceSetterDeletionSnapshot } from "../lib/priceSetterMutation.ts"

const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const otherActor = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const read = async (f, owner = actor) => (await f.db.query(
  "select public.read_price_setter_creation_state($1::uuid) as result", [owner])).rows[0].result
const create = async (f, id = randomUUID(), kind = "port", version = "0", owner = actor) => (await f.db.query(
  "select public.create_owned_price_setter_port($1::uuid,$2::uuid,$3::text,$4::bigint) as result", [owner, id, kind, version])).rows[0].result
const ack = async (f, id, owner = actor) => (await f.db.query(
  "select public.acknowledge_price_setter_creation($1::uuid,$2::uuid) as result", [owner, id])).rows[0].result
const all = async f => ({ ...await f.state(),
  receipts: (await f.db.query("select * from price_setter_creation_receipts order by request_id")).rows,
  fence: (await f.db.query("select public.get_bunker_map_backup_export_fence() as result")).rows[0].result,
})
const conflict = code => error => error.code === "P0002" && error.message === code

test("server state recovers a committed addition independently of browser memory; retry preserves current saved edits", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    await f.db.exec("set role service_role")
    assert.deepEqual(await read(f), { actorId: actor, version: "0", pending: null })
    const requestId = randomUUID(), result = await create(f, requestId)
    // Discard the response as if the document and all browser storage vanished.
    const recovered = await read(f)
    assert.deepEqual(recovered, { actorId: actor, version: "1", pending: { requestId, kind: "port" } })
    await f.db.query("update ports set name='Edited since creation',hsfo=0,display_order=-1 where id=$1", [result.portId])
    const before = await all(f), replay = await create(f, recovered.pending.requestId, recovered.pending.kind, recovered.version)
    assert.equal(replay.replayed, true); assert.equal(replay.portId, result.portId)
    assert.equal(replay.port.name, "Edited since creation"); assert.equal(replay.port.hsfo, 0)
    assert.deepEqual(await all(f), before, "recovery is read-only, including the real backup fence")
  } finally { await f.db.close() }
})

test("two-tab interleaving permits one pending addition per administrator, not one per browser request ID", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    await f.db.exec("set role service_role")
    const tabOne = await read(f), tabTwo = await read(f), id = randomUUID()
    const result = await create(f, id, "port", tabOne.version), before = await all(f)
    for (const kind of ["port", "divider"]) {
      await assert.rejects(create(f, randomUUID(), kind, tabTwo.version), conflict("CREATION_PENDING"))
      assert.deepEqual(await all(f), before)
    }
    assert.equal((await create(f, id, "port", tabTwo.version)).portId, result.portId)
    await assert.rejects(create(f, id, "divider", tabTwo.version), conflict("CREATION_KIND_CHANGED"))
    assert.deepEqual(await all(f), before)
    assert.deepEqual(await read(f, otherActor), { actorId: otherActor, version: "0", pending: null })
    assert.equal((await create(f, randomUUID(), "divider", "0", otherActor)).port.type, "divider")
    assert.equal((await read(f)).pending.requestId, id)
  } finally { await f.db.close() }
})

test("a delayed unknown request cannot allocate after a different request is acknowledged; old exact retries stay read-only", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    await f.db.exec("set role service_role")
    const staleVersion = (await read(f)).version, id = randomUUID(), first = await create(f, id)
    assert.deepEqual(await ack(f, id), { actorId: actor, requestId: id, acknowledged: true })
    const before = await all(f)
    assert.deepEqual(await read(f), { actorId: actor, version: "1", pending: null })
    await assert.rejects(create(f, randomUUID(), "port", staleVersion), conflict("CREATION_VERSION_CHANGED"))
    assert.deepEqual(await all(f), before)
    const nextId = randomUUID(), next = await create(f, nextId, "port", "1")
    assert.notEqual(next.portId, first.portId)
    const pending = await all(f)
    assert.equal((await create(f, id, "port", staleVersion)).portId, first.portId)
    await ack(f, id)
    assert.equal((await read(f)).pending.requestId, nextId, "a delayed old acknowledgement cannot settle a newer addition")
    assert.deepEqual(await all(f), pending)
  } finally { await f.db.close() }
})

test("foreign and legacy unowned receipts cannot be claimed, read by request ID, or acknowledged", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    await f.db.exec("set role service_role")
    const id = randomUUID(), result = await create(f, id)
    const legacyId = randomUUID()
    await f.db.query("select public.create_price_setter_port($1::uuid,'port')", [legacyId])
    const before = await all(f)
    for (const [requestId, owner] of [[id, otherActor], [legacyId, actor], [legacyId, otherActor]]) {
      await assert.rejects(create(f, requestId, "port", "0", owner), conflict("CREATION_OWNER_MISMATCH"))
      await assert.rejects(ack(f, requestId, owner), conflict("CREATION_OWNER_MISMATCH"))
      assert.deepEqual(await all(f), before)
    }
    assert.deepEqual(await read(f, otherActor), { actorId: otherActor, version: "0", pending: null })
    assert.equal((await read(f)).pending.requestId, id)
    assert.equal((await create(f, id)).portId, result.portId)
  } finally { await f.db.close() }
})

test("a deleted pending port remains recoverable as retired, can be acknowledged and is never resurrected", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    await f.db.exec("set role service_role")
    const id = randomUUID(), result = await create(f, id)
    await f.db.query("select public.delete_price_setter_port($1,$2::jsonb,'{}'::jsonb)",
      [result.portId, JSON.stringify(priceSetterDeletionSnapshot(result.port))])
    const before = await all(f)
    assert.deepEqual(await create(f, id), { requestId: id, portId: result.portId, kind: "port", replayed: true, port: null })
    assert.deepEqual(await all(f), before)
    await ack(f, id)
    const settled = await all(f)
    await ack(f, id); assert.deepEqual(await all(f), settled)
    await assert.rejects(create(f), conflict("CREATION_VERSION_CHANGED"))
    const next = await create(f, randomUUID(), "port", (await read(f)).version)
    assert.notEqual(next.portId, result.portId)
    assert.equal((await create(f, id)).port, null)
    assert.equal((await read(f)).version, "2")
  } finally { await f.db.close() }
})

test("invalid inputs, stale revisions and order overflow change no ports, receipts, history or mutation markers", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    const before = await all(f)
    for (const args of [[null, randomUUID(), "port", "0"], [actor, null, "port", "0"], [actor, randomUUID(), null, "0"],
      [actor, randomUUID(), "PORT", "0"], [actor, randomUUID(), "port", null], [actor, randomUUID(), "port", "-1"]]) {
      await assert.rejects(f.db.query("select public.create_owned_price_setter_port($1::uuid,$2::uuid,$3,$4::bigint)", args), e => e.code === "22023")
      assert.deepEqual(await all(f), before)
    }
    await assert.rejects(read(f, null), e => e.code === "22023")
    await assert.rejects(ack(f, null), e => e.code === "22023")
    await assert.rejects(ack(f, randomUUID()), conflict("CREATION_OWNER_MISMATCH"))
    await assert.rejects(create(f, randomUUID(), "port", "9223372036854775807"), conflict("CREATION_VERSION_CHANGED"))
    assert.deepEqual(await all(f), before)
    await f.db.exec("update ports set display_order=2147483647")
    const overflow = await all(f)
    await assert.rejects(create(f), conflict("CREATION_ORDER_FULL"))
    assert.deepEqual(await all(f), overflow)
  } finally { await f.db.close() }
})

test("suppressed or altered allocation/receipt triggers roll back and the original request remains retryable", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    for (const [table, body] of [["ports", "return null;"], ["ports", "new.mgo:=99; return new;"],
      ["price_setter_creation_receipts", "return null;"], ["price_setter_creation_receipts", `new.actor_id:='${otherActor}'; return new;`],
      ["price_setter_creation_receipts", "new.acknowledged_at:=new.created_at; return new;"]]) {
      await f.db.exec(`create function public.creation_recovery_fixture() returns trigger language plpgsql as $$begin ${body} end$$;
        create trigger fixture_failure before insert on public.${table} for each row execute function public.creation_recovery_fixture();`)
      const before = await all(f), id = randomUUID()
      await assert.rejects(create(f, id)); assert.deepEqual(await all(f), before)
      await f.db.exec(`drop trigger fixture_failure on public.${table}; drop function public.creation_recovery_fixture();`)
      assert.equal((await create(f, id, "port", (await read(f)).version)).replayed, false)
      await ack(f, id)
    }
  } finally { await f.db.close() }
})

test("acknowledgement verifies the stored receipt after triggers; failed or suppressed acknowledgements retain pending state", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    const id = randomUUID(); await create(f, id)
    for (const body of ["return null;", "new.acknowledged_at:=null; return new;", "new.kind:='divider'; return new;", "raise exception 'synthetic acknowledgement failure';"]) {
      await f.db.exec(`create function public.creation_recovery_fixture() returns trigger language plpgsql as $$begin ${body} end$$;
        create trigger fixture_failure before update on public.price_setter_creation_receipts for each row execute function public.creation_recovery_fixture();`)
      const before = await all(f)
      await assert.rejects(ack(f, id)); assert.deepEqual(await all(f), before)
      await f.db.exec("drop trigger fixture_failure on public.price_setter_creation_receipts; drop function public.creation_recovery_fixture();")
    }
    await f.db.exec("set role service_role")
    await ack(f, id); assert.equal((await read(f)).pending, null)
  } finally { await f.db.close() }
})

test("recovery functions are invoker-only and service-only; receipts retain RLS, immutable identities and no deletion/expiry", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    const signatures = ["read_price_setter_creation_state(uuid)", "create_owned_price_setter_port(uuid,uuid,text,bigint)", "acknowledge_price_setter_creation(uuid,uuid)"]
    for (const signature of signatures) {
      const meta = (await f.db.query("select prosecdef,proconfig from pg_proc where oid=$1::regprocedure", [`public.${signature}`])).rows[0]
      assert.equal(meta.prosecdef, false); assert.ok(meta.proconfig.includes('search_path=""'))
      for (const role of ["anon", "authenticated", "service_role"]) {
        assert.equal((await f.db.query("select has_function_privilege($1,$2,'execute') as ok", [role, `public.${signature}`])).rows[0].ok, role === "service_role")
      }
    }
    assert.equal((await f.db.query("select relrowsecurity from pg_class where oid='price_setter_creation_receipts'::regclass")).rows[0].relrowsecurity, true)
    assert.equal((await f.db.query("select count(*)::int as n from pg_constraint where conrelid='price_setter_creation_receipts'::regclass and contype='f'")).rows[0].n, 0)
    for (const role of ["anon", "authenticated"]) {
      await f.db.exec(`set role ${role}`)
      await assert.rejects(read(f), e => e.code === "42501")
      await assert.rejects(create(f), e => e.code === "42501")
      await assert.rejects(ack(f, randomUUID()), e => e.code === "42501")
      await f.db.exec("reset role")
    }
    await f.db.exec("set role service_role")
    const id = randomUUID(), before = await all(f)
    await create(f, id); const committed = await all(f)
    assert.ok(committed.fence.epoch > before.fence.epoch)
    await read(f); await create(f, id); assert.deepEqual(await all(f), committed)
    await f.db.exec("begin"); await ack(f, id); await f.db.exec("rollback")
    assert.deepEqual(await all(f), committed)
    await ack(f, id); const acknowledged = await all(f)
    assert.ok(acknowledged.fence.epoch > committed.fence.epoch)
    await ack(f, id); assert.deepEqual(await all(f), acknowledged)
    for (const sql of ["delete from price_setter_creation_receipts", "truncate price_setter_creation_receipts",
      "update price_setter_creation_receipts set actor_id=null", "update price_setter_creation_receipts set request_id=gen_random_uuid()",
      "update price_setter_creation_receipts set created_at=clock_timestamp()", "update price_setter_creation_receipts set kind='divider'"]) {
      await assert.rejects(f.db.exec(sql), e => e.code === "42501")
      assert.deepEqual(await all(f), acknowledged)
    }
  } finally { await f.db.close() }
})

test("actual SQL receipt JSON passes the real backup validator without losing ownership, acknowledgement or retired identities", async () => {
  const f = await setup({ creationRecovery: true })
  try {
    const text = readFileSync(new URL("../scripts/validate-backup.mjs", import.meta.url), "utf8")
    const start = text.indexOf("function validatePriceSetterCreationReceipts"), end = text.indexOf("function validateSections", start)
    assert.ok(start >= 0 && end > start)
    const code = transformSync(text.slice(start, end), { loader: "js", format: "cjs", target: "node24" }).code
    const validate = new Function(`${code};return validatePriceSetterCreationReceipts;`)()
    const id = randomUUID(), result = await create(f, id)
    await ack(f, id)
    await f.db.query("select public.delete_price_setter_port($1,$2::jsonb,'{}'::jsonb)",
      [result.portId, JSON.stringify(priceSetterDeletionSnapshot(result.port))])
    const pending = await create(f, randomUUID(), "divider", "1")
    const rows = (await f.db.query("select to_jsonb(r) as receipt from price_setter_creation_receipts r order by request_id")).rows.map(r => r.receipt)
    assert.equal(rows.length, 2)
    assert.ok(rows.every(r => r.actor_id === actor && Object.hasOwn(r, "acknowledged_at")))
    assert.ok(rows.find(r => r.port_id === result.portId).acknowledged_at)
    assert.equal(rows.find(r => r.port_id === pending.portId).acknowledged_at, null)
    assert.deepEqual(validate(rows, "recovery-v2"), [])
    const omitted = rows.map(({ actor_id, acknowledged_at, ...row }) => row)
    assert.equal(validate(omitted, "recovery-v2").length, 2)
    assert.deepEqual(validate(omitted, "creation-v1"), [], "the earlier proven receipt schema remains valid without ownership fields")
    const before = await all(f)
    await assert.rejects(f.db.query("insert into price_setter_creation_receipts(request_id,port_id,kind,actor_id) values($1,$2,'port',$3)",
      [randomUUID(), randomUUID(), actor]), e => e.code === "23505")
    await assert.rejects(f.db.query("update price_setter_creation_receipts set acknowledged_at=created_at-interval '1 microsecond' where request_id=$1", [id]), e => e.code === "23514")
    assert.deepEqual(await all(f), before)
  } finally { await f.db.close() }
})
