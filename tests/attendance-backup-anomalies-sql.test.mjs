import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const migration = readFileSync(new URL(
  "../supabase/migrations/20261014044025_backup_attendance_dingtalk_anomalies.sql",
  import.meta.url,
), "utf8")

test("service-only private evidence pages are complete and every ledger write advances the backup fence", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema private;
      create table private.backup_mutation_test (id serial primary key);
      create function private.record_bunker_map_backup_mutation() returns trigger
      language plpgsql security definer as $$
      begin insert into private.backup_mutation_test default values; return null; end $$;
      create table private.attendance_dingtalk_punch_anomalies (id uuid primary key, note text);
      create table private.attendance_dingtalk_punch_anomaly_resolutions (anomaly_id uuid primary key, note text);
      create table private.attendance_dingtalk_missing_punch_anomalies (id uuid primary key, note text);
      create table private.attendance_dingtalk_missing_punch_resolutions (anomaly_id uuid primary key, note text);
    `)
    await db.exec(migration)
    const signature = "public.get_attendance_dingtalk_anomaly_backup_page(text,uuid,integer)"
    const privileges = (await db.query(`select
      has_function_privilege('anon',$1,'EXECUTE') as anonymous,
      has_function_privilege('authenticated',$1,'EXECUTE') as staff,
      has_function_privilege('service_role',$1,'EXECUTE') as service`, [signature])).rows[0]
    assert.deepEqual(privileges, { anonymous: false, staff: false, service: true })

    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"]
    await db.query(`insert into private.attendance_dingtalk_punch_anomalies (id,note)
      values ($1,'first'),($2,'second'),($3,'third')`, [ids[2], ids[0], ids[1]])
    await db.query("insert into private.attendance_dingtalk_punch_anomaly_resolutions values ($1,'reviewed')", [ids[0]])
    await db.query("insert into private.attendance_dingtalk_missing_punch_anomalies values ($1,'missing')", [ids[1]])
    await db.query("insert into private.attendance_dingtalk_missing_punch_resolutions values ($1,'reviewed missing')", [ids[1]])
    const page = async (section, after = null, limit = 500) => (await db.query(
      "select public.get_attendance_dingtalk_anomaly_backup_page($1,$2,$3) as rows",
      [section, after, limit],
    )).rows[0].rows
    assert.deepEqual((await page("attendanceDingtalkPunchAnomalies", null, 2)).map((row) => row.id), ids.slice(0, 2))
    assert.deepEqual((await page("attendanceDingtalkPunchAnomalies", ids[1], 2)).map((row) => row.id), [ids[2]])
    assert.deepEqual((await page("attendanceDingtalkPunchAnomalyResolutions")).map((row) => row.anomaly_id), [ids[0]])
    assert.deepEqual((await page("attendanceDingtalkMissingPunchAnomalies")).map((row) => row.id), [ids[1]])
    assert.deepEqual((await page("attendanceDingtalkMissingPunchResolutions")).map((row) => row.anomaly_id), [ids[1]])
    assert.equal((await db.query("select count(*)::int as count from private.backup_mutation_test")).rows[0].count, 4)
    await assert.rejects(page("unsupported"), /Unknown attendance anomaly backup section/)
    await assert.rejects(page("attendanceDingtalkPunchAnomalies", null, 501), /page size/)
  } finally {
    await db.close()
  }
})
