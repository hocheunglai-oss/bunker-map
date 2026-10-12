import assert from "node:assert/strict"
import test from "node:test"
import { setup, basis, linked, chained, other } from "./fixtures/price-setter-sql.mjs"

async function snapshot(app) { return (await app.db.query("select coalesce(jsonb_agg(jsonb_build_array(id,display_order) order by display_order asc nulls last,id),'[]'::jsonb) as value from ports")).rows[0].value }
async function reorder(app, expected, order) { return (await app.db.query("select public.reorder_price_setter_ports($1::jsonb,$2::uuid[]) as result", [JSON.stringify(expected), order])).rows[0].result }

test("order transaction changes only positions, preserves hidden slots and prices, and confirms lost-response replay", async () => {
  const app = await setup()
  try {
    await app.db.exec(`update ports set display_order=case id when '${basis}' then 3 when '${linked}' then 10 when '${chained}' then 10 else null end; set role service_role`)
    const before = await app.state(), expected = await snapshot(app), order = [basis, other, chained, linked]
    const result = await reorder(app, expected, order)
    assert.deepEqual(result, { order: order.map((id, i) => [id, i + 1]), replayed: false })
    for (const port of (await app.state()).ports) assert.deepEqual({ ...port, display_order: before.ports.find(row => row.id === port.id).display_order }, before.ports.find(row => row.id === port.id))
    const saved = await app.state()
    assert.equal((await reorder(app, expected, order)).replayed, true); assert.deepEqual(await app.state(), saved)
    await assert.rejects(reorder(app, expected, [other, basis, chained, linked]), error => error.code === "P0002")
    assert.deepEqual(await app.state(), saved)
  } finally { await app.db.close() }
})

test("ordering rollback is all-or-nothing; added/deleted lists conflict, unrelated price edits survive", async () => {
  const app = await setup()
  try {
    const expected = await snapshot(app), order = [other, chained, linked, basis]
    await app.db.exec("update ports set hsfo=999 where name='Basis'")
    await reorder(app, expected, order); assert.equal((await app.row()).hsfo, 999)
    const next = await snapshot(app)
    await app.db.exec("insert into ports(name) values('New port')")
    const added = await app.state()
    await assert.rejects(reorder(app, next, [basis, linked, chained, other]), error => error.code === "P0002"); assert.deepEqual(await app.state(), added)
    await app.db.exec("delete from ports where name='New port'; delete from ports where name='Other'")
    await assert.rejects(reorder(app, next, order), error => error.code === "P0002")
    const current = await snapshot(app), before = await app.state()
    await app.db.exec(`create function synthetic_order_failure() returns trigger language plpgsql as $$ begin if new.id='${linked}'::uuid then raise exception 'SYNTHETIC_FAILURE'; end if; return new; end $$; create trigger order_failure before update on ports for each row execute function synthetic_order_failure()`)
    await assert.rejects(reorder(app, current, [basis, linked, chained]), /SYNTHETIC_FAILURE/)
    assert.deepEqual(await app.state(), before)
  } finally { await app.db.close() }
})

test("order RPC is service-only/invoker, rejects malformed direct SQL and cannot drop or invent IDs", async () => {
  const app = await setup()
  try {
    assert.equal((await app.db.query("select prosecdef from pg_proc where proname='reorder_price_setter_ports'")).rows[0].prosecdef, false)
    for (const role of ["anon", "authenticated"]) {
      await app.db.exec(`set role ${role}`); await assert.rejects(reorder(app, [], []), error => error.code === "42501"); await app.db.exec("reset role")
    }
    const expected = await snapshot(app), before = await app.state()
    for (const [baseline, order] of [[null, []], [[], []], [{}, []], [[{}], [basis]], [[[basis, 1.5]], [basis]], [[[basis, "1"]], [basis]], [[[basis, null], [basis, null]], [basis, linked]], [expected, [basis, basis, chained, other]], [expected, [basis, linked]], [expected, null]]) {
      await assert.rejects(reorder(app, baseline, order), error => error.code === "22023")
      assert.deepEqual(await app.state(), before)
    }
  } finally { await app.db.close() }
})
