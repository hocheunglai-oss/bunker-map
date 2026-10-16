import assert from "node:assert/strict"
import test from "node:test"
import { statisticsFixtureSql, seedStatisticsSql, statisticsCall, statisticsStateSql } from "./fixtures/spc-statistics-sql.mjs"
const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const read = async db => (await db.query(`select ${statisticsCall} as source`)).rows[0].source
test("portable statistics read RPC is complete, private, bounded and non-mutating", async t => {
  const db = new PGlite()
  try {
    await db.exec(statisticsFixtureSql()); await db.exec(seedStatisticsSql(5001))
    await t.test("all 5001 rows and audit membership survive without PostgREST row caps", async () => {
      const before = (await db.query(statisticsStateSql)).rows[0].state
      await db.exec("begin read only; set local role service_role")
      const source = await read(db); await db.exec("commit")
      assert.equal(source.schema, "fcuno.spc-statistics-source/v1"); assert.equal(source.complete, true)
      assert.equal(source.fixtures.length, 5001); assert.equal(source.enquiries.length, 5001); assert.equal(source.buyerEnquiryNumbers.length, 5001)
      assert.equal(source.fixtures.reduce((sum,row) => sum + Number(row.hsfo), 0), 500100)
      for (const [kind,count] of Object.entries(source.counts)) assert.equal(source[kind].length, count)
      assert.equal(JSON.stringify(source).includes("DO-NOT-EXPORT"), false)
      assert.deepEqual((await db.query(statisticsStateSql)).rows[0].state, before)
    })
    await t.test("exact service-only invoker stable/empty-path/15s metadata and denied roles", async () => {
      const meta = (await db.query("select prosecdef,provolatile,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') auth,has_function_privilege('service_role',oid,'execute') service from pg_proc where oid='public.read_spc_statistics_source(integer,integer,timestamptz,timestamptz)'::regprocedure")).rows[0]
      assert.deepEqual(meta, { prosecdef:false, provolatile:'s', proconfig:['search_path=""','statement_timeout=15s'], anon:false, auth:false, service:true })
      for (const role of ["anon", "authenticated"]) { await db.exec(`set role ${role}`); await assert.rejects(read(db), error => error.code === "42501"); await db.exec("reset role") }
    })
    await t.test("invalid/null/infinite/reversed/out-of-range bounds fail 22023", async () => {
      for (const args of ["null,2026,'2026-07-19Z','2026-10-16Z'", "1998,2026,'2026-07-19Z','2026-10-16Z'", "2025,2101,'2026-07-19Z','2026-10-16Z'", "2026,2025,'2026-07-19Z','2026-10-16Z'", "2025,2026,'infinity','2026-10-16Z'", "2025,2026,'2026-10-16Z','2026-07-19Z'", "2025,2026,'2026-01-01Z','2026-10-16Z'", "2025,2026,'2024-10-01Z','2024-10-16Z'"]) {
        await assert.rejects(db.query(`select public.read_spc_statistics_source(${args})`), error => error.code === "22023")
      }
    })
    await t.test("oversize individual field is explicit failure, not partial success", async () => {
      await db.exec("update public.spc_enquiries set title=repeat('x',1048577) where id=md5('enquiry-1')::uuid")
      const before = (await db.query(statisticsStateSql)).rows[0].state
      await assert.rejects(read(db), error => error.code === "54000" && error.message.includes("no partial totals"))
      assert.deepEqual((await db.query(statisticsStateSql)).rows[0].state, before)
      await db.exec("update public.spc_enquiries set title='Synthetic Vessel'")
    })
    await t.test("32 MiB aggregate budget rejects explicitly before a giant aggregate", async () => {
      await db.exec("update public.spc_enquiries set title=repeat('x',7000)")
      await assert.rejects(read(db), error => error.code === "54000" && error.message.includes("no partial totals"))
    })
  } finally { await db.close() }
})
