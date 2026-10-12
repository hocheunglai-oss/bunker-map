import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { setupMarketHistoryApp } from "./fixtures/market-price-history-app.mjs"
import { parseMarketHistorySnapshot, validateMarketHistoryChange, confirmMarketHistoryChange } from "../lib/marketPriceHistory.ts"

const fix = readFileSync(new URL("../supabase/migrations/20261012112711_normalize_market_history_root_lookup.sql", import.meta.url), "utf8")
const roots = ["Hong Kong", "Kaohsiung", "Taichung", "Keelung", "Suao", "Hualien"]

async function fixture() {
  const f = await setupMarketHistoryApp()
  await f.db.exec(`reset role;${fix};set role service_role`)
  return f
}
async function input(f, market, day = "2026-10-11") {
  const response = await f.read(market)
  assert.equal(response.status, 200)
  const snapshot = parseMarketHistorySnapshot(await response.json(), market)
  return validateMarketHistoryChange({ day, operation: "save", expectedPorts: snapshot.ports,
    expectedRows: snapshot.rows.filter(row => row.recorded_at.slice(0, 10) === day),
    values: snapshot.ports.map(p => ({ port_id: p.id, hsfo: p.name.trim().toLowerCase() === "taichung" ? null : 0, vlsfo: 800, mgo: 1000 })) }, market)
}
async function save(f, market, data) {
  const response = await f.route.POST(new Request(`http://localhost/api/admin/price-history?market=${market}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  }))
  return { status: response.status, body: await response.json() }
}

for (const root of roots) test(`allowed root capitalisation preserves raw name and both history/publication paths: ${root}`, async () => {
  const f = await fixture()
  try {
    const label = ` ${root.toUpperCase()} `
    await f.db.query("update ports set name=$1 where name=$2", [label, root])
    const market = root === "Hong Kong" ? "hongkong" : "taiwan"
    const data = await input(f, market), result = await save(f, market, data)
    assert.equal(result.status, 200)
    confirmMarketHistoryChange(result.body, market, data)
    assert.equal((await f.db.query("select name from ports where lower(btrim(name))=lower($1)", [root])).rows[0].name, label)
    if (["Hong Kong", "Kaohsiung", "Taichung"].includes(root)) assert.ok(data.expectedPorts.some(p => p.name === label), "CAS must use exact persisted spelling")
    const replayState = await f.state(), replay = await save(f, market, data)
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true)
    assert.deepEqual(await f.state(), replayState)
    const deletion = validateMarketHistoryChange({ day: data.day, operation: "delete", expectedPorts: result.body.ports,
      expectedRows: result.body.rows, values: [] }, market)
    const deleted = await save(f, market, deletion)
    assert.equal(deleted.status, 200); assert.deepEqual(deleted.body.rows, [])
    const deletedState = await f.state(), repeatedDelete = await save(f, market, deletion)
    assert.equal(repeatedDelete.status, 200); assert.equal(repeatedDelete.body.replayed, true)
    assert.deepEqual(await f.state(), deletedState)
    const publication = await f.publicationRoute.GET(new Request(`http://localhost/api/admin/report-publication?report=${market}&page=pricesetter`))
    assert.equal(publication.status, 200)
    assert.ok((await publication.json()).preview.rows.length > 0)
  } finally { await f.db.close() }
})

test("normalised lookup does not weaken raw-name CAS or Taichung HSFO restriction", async () => {
  const f = await fixture()
  try {
    await f.db.exec("update ports set name='TAICHUNG' where name='Taichung'")
    const data = await input(f, "taiwan"), wrongProduct = structuredClone(data)
    wrongProduct.values.find(p => p.port_id === f.chained).hsfo = 1
    assert.throws(() => validateMarketHistoryChange(wrongProduct, "taiwan"), /product selection/)
    // Bypass the API validator to prove the same restriction at the SQL boundary.
    await assert.rejects(f.db.query("select change_market_price_history('taiwan',$1::date,'save',$2::jsonb,$3::jsonb,$4::jsonb)",
      [data.day, JSON.stringify(data.expectedPorts), JSON.stringify(data.expectedRows), JSON.stringify(wrongProduct.values)]), e => e.code === "22023")
    await f.db.exec("update ports set name='TaiChung' where name='TAICHUNG'")
    const before = await f.state(), result = await save(f, "taiwan", data)
    assert.equal(result.status, 409); assert.deepEqual(await f.state(), before)
  } finally { await f.db.close() }
})
