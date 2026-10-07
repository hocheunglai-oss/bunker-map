import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Run against isolated, in-memory PostgreSQL. Keep optional test tooling out of
// application dependencies; an explicitly configured missing module must fail.
const modulePath = process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite"
const pglite = await import(modulePath).catch((error) => {
  if (!process.env.PGLITE_MODULE_PATH && error.code === "ERR_MODULE_NOT_FOUND") return null
  throw error
})

test("calendar audit-undo migration guards the existing trigger in real PostgreSQL", {
  skip: pglite ? false : "Set PGLITE_MODULE_PATH to run optional SQL integration tests",
}, async (t) => {
  const db = new pglite.PGlite()
  const sql = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8")
  const setUndo = (id) => db.query("select set_config('app.audit_undo_of_log_id', $1, false)", [id])
  const rows = () => db.query("select key, payload from public.office_calendar_store order by key")
  try {
    await db.exec(`
      create role authenticated;
      create table public.office_calendar_store (key text primary key, payload jsonb not null);
      grant usage on schema public to authenticated;
      grant select, insert, update, delete on public.office_calendar_store to authenticated;
    `)
    await db.exec(sql("20260811125142_block_event_calendar_snapshot_undo.sql"))
    const migration = sql("20261007115435_block_task_calendar_snapshot_undo.sql")
    await db.exec(migration)
    await db.exec(migration)

    await t.test("migration preserves one existing trigger, invoker security and revoked public execution", async () => {
      const trigger = await db.query(`
        select count(*)::integer as count from pg_trigger
        where tgrelid = 'public.office_calendar_store'::regclass and not tgisinternal
          and tgname = 'block_event_calendar_snapshot_undo'
      `)
      assert.equal(trigger.rows[0].count, 1)
      const properties = await db.query(`
        select prosecdef, proconfig,
          has_function_privilege('authenticated', oid, 'EXECUTE') as executable
        from pg_proc where oid = 'public.block_event_calendar_snapshot_undo()'::regprocedure
      `)
      assert.equal(properties.rows[0].prosecdef, false)
      assert.equal(properties.rows[0].executable, false)
      assert.deepEqual(properties.rows[0].proconfig, ["search_path=public, pg_temp"])
    })

    await t.test("ordinary inserts, updates and deletes remain available", async () => {
      await db.exec("set role authenticated")
      try {
        for (const key of ["event-calendar", "task-calendar", "unrelated-store"]) {
          await db.query("insert into public.office_calendar_store values ($1, '{\"version\":1}')", [key])
          await db.query("update public.office_calendar_store set payload = '{\"version\":2}' where key = $1", [key])
          await db.query("delete from public.office_calendar_store where key = $1", [key])
        }
        assert.deepEqual((await rows()).rows, [])
      } finally {
        await db.exec("reset role")
      }
    })

    await t.test("audit-marked insert, update and delete cannot restore either calendar snapshot", async () => {
      for (const [key, title] of [["event-calendar", "Event Calendar"], ["task-calendar", "Task Calendar"]]) {
        await setUndo("audit-undo-1")
        await assert.rejects(
          db.query("insert into public.office_calendar_store values ($1, '{}')", [key]),
          new RegExp(`${title} audit snapshots cannot be undone`),
        )
        await setUndo("")
        await db.query("insert into public.office_calendar_store values ($1, '{\"keep\":true}')", [key])
        await setUndo("audit-undo-1")
        await assert.rejects(
          db.query("update public.office_calendar_store set payload = '{}' where key = $1", [key]),
          new RegExp(`${title} audit snapshots cannot be undone`),
        )
        await assert.rejects(
          db.query("delete from public.office_calendar_store where key = $1", [key]),
          new RegExp(`${title} audit snapshots cannot be undone`),
        )
        const result = await db.query("select payload from public.office_calendar_store where key = $1", [key])
        assert.deepEqual(result.rows[0].payload, { keep: true })
        await setUndo("")
      }
    })

    await t.test("other store keys can still be undone and blank undo context permits ordinary calendar edits", async () => {
      await setUndo("audit-undo-2")
      await db.exec("insert into public.office_calendar_store values ('unrelated-store', '{}')")
      await db.exec("update public.office_calendar_store set payload = '{\"restored\":true}' where key = 'unrelated-store'")
      await db.exec("delete from public.office_calendar_store where key = 'unrelated-store'")
      await setUndo("")
      await db.exec("update public.office_calendar_store set payload = '{\"edited\":true}' where key = 'task-calendar'")
      assert.equal((await rows()).rows.length, 2)
    })
  } finally {
    await db.close()
  }
})
