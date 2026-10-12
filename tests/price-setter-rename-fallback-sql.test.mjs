import assert from "node:assert/strict"
import test from "node:test"
import { priceSetterSnapshot } from "../lib/priceSetterMutation.ts"
import { setup, linked } from "./fixtures/price-setter-sql.mjs"

async function settings(app) {
  return (await app.db.query("select id,content from remarks order by id")).rows
}
async function seed(app, content) {
  await app.db.query("insert into remarks(id,content) values(105,$1) on conflict(id) do update set content=excluded.content", [content])
}

test("renaming moves all three overrides with prices/formulas/history and preserves unrelated notices", async () => {
  const app = await setup()
  try {
    await app.db.exec("insert into remarks(id,content) values(1,'KEEP NOTICE'),(101,'KEEP PUBLISHED REPORT')")
    await seed(app, JSON.stringify({ "basis::hsfo": "NA", "basis::vlsfo": "SE", "basis::mgo": "-", "other::hsfo": "SE" }))
    const expected = priceSetterSnapshot(await app.row())
    await app.save({ name: "New Basis", hsfo: 0 }, { expected })
    assert.deepEqual((await settings(app)).map(row => row.id), [1, 101, 105])
    assert.deepEqual((await settings(app)).slice(0, 2), [
      { id: 1, content: "KEEP NOTICE" }, { id: 101, content: "KEEP PUBLISHED REPORT" },
    ])
    assert.deepEqual(JSON.parse((await settings(app))[2].content), { "new basis::hsfo": "NA", "new basis::vlsfo": "SE", "new basis::mgo": "-", "other::hsfo": "SE" })
    assert.equal((await app.row()).hsfo, 0)
    assert.equal((await app.row(linked)).vlsfo_formula, "New Basis + 0")
    const before = { ...await app.state(), settings: await settings(app) }
    assert.equal((await app.save({ name: "New Basis", hsfo: 0 }, { expected })).replayed, true)
    assert.deepEqual({ ...await app.state(), settings: await settings(app) }, before, "lost-response retry cannot duplicate or move settings again")
    await assert.rejects(app.db.query("select save_price_setter_fallback('basis::hsfo','NA','SE')"), error => error.code === "22023")
    await app.db.query("select save_price_setter_fallback('new basis::hsfo','NA','SE')")
    assert.equal(JSON.parse((await settings(app))[2].content)["new basis::hsfo"], "SE")
  } finally { await app.db.close() }
})

test("rename refuses corrupt maps, conflicting/orphan destination values and rolls back all tables", async () => {
  const app = await setup()
  try {
    for (const [content, code] of [
      ["{broken", "P0001"], ["null", "P0001"], ["[]", "P0001"], ['{"basis::hsfo":null}', "P0001"],
      ['{"BASIS::hsfo":"NA"}', "P0001"], ['{"basis::hsfo":"bad"}', "P0001"],
      ['{"basis::hsfo":"NA","new basis::hsfo":"SE"}', "P0002"],
      ['{"new basis::mgo":"SE"}', "P0002"],
    ]) {
      await seed(app, content)
      const before = { ...await app.state(), settings: await settings(app) }
      await assert.rejects(app.save({ name: "New Basis", hsfo: 777 }), error => error.code === code)
      assert.deepEqual({ ...await app.state(), settings: await settings(app) }, before)
    }
    await seed(app, '{"basis::hsfo":"NA","new basis::hsfo":"NA"}')
    await app.save({ name: "New Basis" })
    assert.deepEqual(JSON.parse((await settings(app))[0].content), { "new basis::hsfo": "NA" })
  } finally { await app.db.close() }
})

test("later history/remark failures roll back migrated settings; case-only and whitespace renames keep exact keys", async () => {
  for (const stage of ["history", "remarks", "case", "whitespace", "missing"]) {
    const app = await setup()
    try {
      if (stage !== "missing") await seed(app, '{"basis::hsfo":"NA"}')
      if (stage === "history" || stage === "remarks") {
        await app.db.exec(`create function synthetic_rename_failure() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE FAILURE'; end $$; create trigger synthetic_rename_failure before ${stage === "history" ? "insert on price_history" : "update on remarks"} for each row execute function synthetic_rename_failure()`)
        const before = { ...await app.state(), settings: await settings(app) }
        await assert.rejects(app.save({ name: "New Basis" }), /PRIVATE FAILURE/)
        assert.deepEqual({ ...await app.state(), settings: await settings(app) }, before)
      } else if (stage === "case") {
        await app.save({ name: "BASIS" })
        assert.equal((await settings(app))[0].content, '{"basis::hsfo":"NA"}')
      } else if (stage === "whitespace") {
        await app.db.exec("update ports set name=' Basis ' where name='Basis'; update remarks set content='{\" basis ::hsfo\":\"NA\"}' where id=105")
        await app.save({ name: "Basis" })
        assert.deepEqual(JSON.parse((await settings(app))[0].content), { "basis::hsfo": "NA" })
      } else {
        await app.save({ name: "New Basis" })
        assert.deepEqual(await settings(app), [], "a missing map stays absent; rename does not invent overrides")
      }
    } finally { await app.db.close() }
  }
})
