import assert from "node:assert/strict"
import test from "node:test"
import { savePriceHistoryForMarketDate } from "../lib/priceHistoryRecords.ts"

// Optional, isolated PostgreSQL runtime; no production credentials or schema writes.
// Run with node --import tsx --test and an explicit PGLITE_MODULE_PATH.
const pglite = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite").catch(error => {
  if (!process.env.PGLITE_MODULE_PATH && error.code === "ERR_MODULE_NOT_FOUND") return null
  throw error
})

test("price history keeps the Hong Kong day through real timestamp-without-time-zone storage", {
  skip: pglite ? false : "Set PGLITE_MODULE_PATH for isolated PostgreSQL integration",
}, async () => {
  const db = new pglite.PGlite()
  try {
    await db.exec("create table price_history (id serial primary key, port_id text not null, hsfo numeric, vlsfo numeric, mgo numeric, recorded_at timestamp without time zone not null)")
    const columns = `id, port_id, hsfo::float8 as hsfo, vlsfo::float8 as vlsfo, mgo::float8 as mgo, to_char(recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') as recorded_at`
    const client = { from(table) {
      assert.equal(table, "price_history")
      let action = "read", payload, id, portId, lower, upper, ids
      const query = {
        select() { return query }, single() { return query }, order() { return query },
        eq(key, value) { if (key === "id") id = value; else if (key === "port_id") portId = value; else throw Error("Unexpected filter"); return query },
        gte(key, value) { assert.equal(key, "recorded_at"); lower = value; return query },
        lt(key, value) { assert.equal(key, "recorded_at"); upper = value; return query },
        in(key, value) { assert.equal(key, "id"); ids = value; return query },
        insert(value) { action = "insert"; payload = value; return query },
        update(value) { action = "update"; payload = value; return query },
        delete() { action = "delete"; return query },
        then(resolve, reject) { return (async () => {
          if (action === "read") {
            const result = await db.query(`select ${columns} from price_history where port_id = $1 and recorded_at >= $2::timestamp and recorded_at < $3::timestamp order by recorded_at desc, id desc`, [portId, lower, upper])
            return { data: result.rows, error: null }
          }
          if (action === "delete") {
            await db.query("delete from price_history where id = any($1::int[])", [ids])
            return { data: null, error: null }
          }
          const params = [payload.port_id, payload.hsfo, payload.vlsfo, payload.mgo, payload.recorded_at]
          const result = action === "insert"
            ? await db.query(`insert into price_history (port_id, hsfo, vlsfo, mgo, recorded_at) values ($1,$2,$3,$4,$5::timestamp) returning ${columns}`, params)
            : await db.query(`update price_history set port_id=$1,hsfo=$2,vlsfo=$3,mgo=$4,recorded_at=$5::timestamp where id=$6 returning ${columns}`, [...params, id])
          return { data: result.rows[0], error: null }
        })().then(resolve, reject) },
      }
      return query
    } }
    const initial = await db.query("select $1::text::timestamp::date::text as naive_day, ($1::text::timestamptz at time zone 'Asia/Hong_Kong')::date::text as market_day", ["2026-10-08T18:30:00Z"])
    assert.deepEqual(initial.rows, [{ naive_day: "2026-10-08", market_day: "2026-10-09" }], "prove the original storage mismatch")
    const first = await savePriceHistoryForMarketDate(client, { portId: "port", recordedAt: "2026-10-08T18:30:00.123Z", values: { hsfo: 0, vlsfo: 800, mgo: 1000 } })
    assert.equal(first.recorded_at, "2026-10-09T02:30:00.123")
    assert.equal(first.hsfo, 0)
    const second = await savePriceHistoryForMarketDate(client, { portId: "port", recordedAt: "2026-10-09T12:00:00+08:00", values: { hsfo: 10, vlsfo: 810, mgo: 1010 } })
    assert.equal(second.id, first.id, "the same Hong Kong day updates rather than creating another record")
    assert.equal(second.recorded_at, "2026-10-09T12:00:00.000")
    await savePriceHistoryForMarketDate(client, { portId: "port", recordedAt: "2026-10-09T13:00:00", values: { hsfo: 20, vlsfo: 820, mgo: 1020 } })
    assert.deepEqual((await db.query("select count(*)::integer as total from price_history")).rows, [{ total: 1 }])
    await savePriceHistoryForMarketDate(client, { portId: "port", recordedAt: "2026-10-07T18:30:00Z", values: { hsfo: 30, vlsfo: 830, mgo: 1030 } })
    assert.deepEqual((await db.query("select recorded_at::date::text as day from price_history order by recorded_at")).rows, [{ day: "2026-10-08" }, { day: "2026-10-09" }])
  } finally {
    await db.close()
  }
})
