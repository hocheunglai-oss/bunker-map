import assert from "node:assert/strict"
import test from "node:test"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"

test("actual API/audit/SQL coherently reads and publishes all four reports with pinned permissions", async () => {
  const f = await setupReportPublicationApp()
  try {
    for (const report of ["hongkong", "taiwan", "china", "compact"]) {
      const before = await f.state(), input = await f.input(report)
      assert.deepEqual(await f.state(), before, "GET never mutates prices/history")
      const response = await f.publish(input, report), result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.report, report)
      assert.equal(result.reportDate, "08 Oct 2026"); assert.equal(result.replayed, false)
      const loaded = await (await f.read(report)).json()
      assert.equal(loaded.publicationVersion, result.publicationVersion)
      assert.equal(loaded.sourceVersion, result.sourceVersion)
      assert.equal(loaded.publishedReportDate, result.reportDate)
    }
    assert.equal((await f.publications()).length, 4)
    const taiwan = JSON.parse((await f.publications()).find(row => row.id === 101).content)
    assert.equal(taiwan.rows.length, 5); assert.equal(taiwan.remark, "Remark\nSecond line")
    assert.equal(taiwan.specialNotice, "Special notice\nSecond line")
    assert.equal(f.permissions[0].page, "hongkong-price-history")
    assert.ok(f.auditHeaders.every(headers => headers["x-bunker-admin-user"] === "SERVER-EDITOR" && !headers["x-bunker-admin-page-path"].includes("users")))
    assert.ok(f.permissions.some(item => item.page === "pricesetter" && item.access === "edit"))
  } finally { await f.db.close() }
})

test("database chooses latest distinct days beyond 1,000 rows, preserves microseconds and zero", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.exec(`insert into price_history(port_id,recorded_at,hsfo,vlsfo,mgo) select '${f.basis}','2026-10-08'::timestamp+g*interval '1 second',1,2,3 from generate_series(1,1100) g;
      insert into price_history(port_id,recorded_at,hsfo,vlsfo,mgo) values ('${f.basis}','2026-10-08T23:30:00.000003',0,0,0),('${f.basis}','2026-10-06T23:59:59.999999',400,600,800)`)
    const data = await (await f.read("hongkong")).json(), row = data.preview.rows[0]
    assert.equal(row.todayDate, "2026-10-08T23:30:00.000003")
    assert.equal(row.last1Date, "2026-10-07T23:30:00.000001")
    assert.equal(row.last2Date, "2026-10-06T23:59:59.999999")
    assert.equal(row.hsfo.today, 0); assert.equal(row.hsfo.last1, 500); assert.equal(row.hsfo.last2, 400)
  } finally { await f.db.close() }
})

test("Taiwan and China resolve out-of-report dependencies without including them as report rows", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.exec(`insert into ports(name,hsfo,vlsfo,mgo,updated_at) values ('External Basis',10,20,30,'2026-10-09');
      insert into price_history(port_id,recorded_at,hsfo,vlsfo,mgo) select id,'2026-10-09T12:00:00',10,20,30 from ports where name='External Basis';
      update ports set vlsfo_formula='External Basis + 5' where name='Taichung';
      update ports set mgo_formula='External Basis - -5' where name='Dalian'`)
    let data = await (await f.read()).json()
    assert.equal(data.preview.rows.length, 5); assert.equal(data.preview.reportDate, "09 Oct 2026")
    for (const name of ["Taichung", "Keelung", "Suao", "Hualien"]) assert.equal(data.preview.rows.find(row => row.port === name).vlsfo.today, 25)
    data = await (await f.read("china")).json()
    const rows = data.preview.sections.flatMap(section => section.rows)
    assert.equal(rows.find(row => row.port === "Dalian").mgo, 35)
    assert.ok(!rows.some(row => row.port === "External Basis"))
  } finally { await f.db.close() }
})

test("stale source, notices and prior publication cannot overwrite current reports", async () => {
  const f = await setupReportPublicationApp()
  try {
    const input = await f.input()
    await f.db.exec("update remarks set content='New notice' where id=2")
    assert.equal((await f.publish(input)).status, 409); assert.deepEqual(await f.publications(), [])
    const current = await f.input(), otherTab = { ...current, dateOverride: "2026-10-10" }
    assert.equal((await f.publish(current)).status, 200)
    const saved = await f.publications()
    assert.equal((await f.publish(otherTab)).status, 409)
    assert.deepEqual(await f.publications(), saved)
    assert.equal((await f.publish({ ...await f.input(), dateOverride: "2026-10-10" })).status, 200)
  } finally { await f.db.close() }
})

test("actual Taiwan preview and publication preserve explicit missing latest quotes through formula dependencies", async () => {
  const f = await setupReportPublicationApp()
  try {
    // Deliberately reproduce inconsistent legacy rows: current port values
    // must not silently override an explicit NULL in the newest history row.
    await f.db.exec(`update ports set hsfo=638,vlsfo=710,mgo=990 where name in ('Kaohsiung','Taichung');
      update price_history set hsfo=null,vlsfo=null,mgo=case when port_id='${f.linked}' then 0 else null end
      where port_id in ('${f.linked}','${f.chained}') and recorded_at::date='2026-10-08'`)
    const before = await f.state(), read = await f.read(), data = await read.json()
    assert.equal(read.status, 200, JSON.stringify(data))
    const khh = data.preview.rows.find(row => row.port === "Kaohsiung")
    assert.deepEqual(khh.hsfo, { today: null, last: 500, change: null })
    assert.deepEqual(khh.vlsfo, { today: null, last: 700, change: null })
    assert.deepEqual(khh.mgo, { today: 0, last: 900, change: -900 })
    for (const name of ["Taichung", "Keelung", "Suao", "Hualien"]) {
      const row = data.preview.rows.find(row => row.port === name)
      assert.deepEqual(row.vlsfo, { today: null, last: 700, change: null })
      assert.deepEqual(row.mgo, { today: null, last: 900, change: null })
    }
    assert.deepEqual(await f.state(), before, "review does not repair or overwrite saved source data")
    assert.deepEqual(await f.publications(), [])
    const response = await f.publish({ sourceVersion: data.sourceVersion, publicationVersion: data.publicationVersion, dateOverride: "" })
    assert.equal(response.status, 200, await response.clone().text())
    const saved = JSON.parse((await f.publications()).find(row => row.id === 101).content)
    assert.deepEqual(saved, data.preview, "the reviewed missing/zero values reach the exact SQL publication")
    assert.deepEqual(await f.state(), before, "publishing never rewrites prices or history")
    const state = (await f.db.query("select public.get_bunker_map_backup_export_fence() as result")).rows[0].result
    const retry = await f.publish({ sourceVersion: data.sourceVersion, publicationVersion: data.publicationVersion, dateOverride: "" })
    assert.equal(retry.status, 200); assert.equal((await retry.json()).replayed, true)
    assert.deepEqual((await f.db.query("select public.get_bunker_map_backup_export_fence() as result")).rows[0].result, state)
  } finally { await f.db.close() }
})

test("SQL rechecks source and publication after server calculation, including absent-row insertion races", async () => {
  const f = await setupReportPublicationApp()
  try {
    const input = await f.input()
    f.control.beforeWrite = async () => f.db.exec("update remarks set content='Concurrent notice' where id=2")
    assert.equal((await f.publish(input)).status, 409); assert.deepEqual(await f.publications(), [])
    const next = await f.input()
    f.control.beforeWrite = async () => f.db.exec(`insert into remarks values (101,'{"reportDate":"10 Oct 2026","rows":[]}')`)
    assert.equal((await f.publish(next)).status, 409)
    assert.equal(JSON.parse((await f.publications())[0].content).reportDate, "10 Oct 2026")
  } finally { await f.db.close() }
})

test("malformed post-commit replies are uncertain; identical retry is read-only and cannot revive obsolete source", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.exec("reset role; create table public.write_log(value integer); grant select on write_log to service_role; create function public.count_report_write() returns trigger language plpgsql security definer as $$begin insert into public.write_log values(new.id);return new;end$$; create trigger report_write after insert or update on remarks for each row execute function public.count_report_write();set role service_role")
    const input = await f.input()
    f.control.badWrite = true
    let response = await f.publish(input)
    assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE/)
    assert.equal((await f.publications()).length, 1)
    f.control.badWrite = false
    response = await f.publish(input)
    assert.equal(response.status, 200); assert.equal((await response.json()).replayed, true)
    assert.equal((await f.db.query("select count(*)::integer as count from write_log")).rows[0].count, 1)
    await f.db.exec("update remarks set content='Changed source' where id=1")
    assert.equal((await f.publish(input)).status, 409)
    assert.equal((await f.db.query("select count(*)::integer as count from write_log where value=101")).rows[0].count, 1)
  } finally { await f.db.close() }
})

test("failed publication trigger rolls back the snapshot without changing prices or history", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.exec("reset role;create function public.fail_report_write() returns trigger language plpgsql as $$begin if new.id=101 then raise exception 'PRIVATE publication failure';end if;return new;end$$;create trigger fail_report before insert or update on remarks for each row execute function public.fail_report_write();set role service_role")
    const before = await f.state(), input = await f.input(), response = await f.publish(input)
    assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE/)
    assert.deepEqual(await f.publications(), []); assert.deepEqual(await f.state(), before)
  } finally { await f.db.close() }
})

test("View access can read but not publish; cross-page and unknown report scopes fail before privileged work", async () => {
  const f = await setupReportPublicationApp()
  try {
    const input = await f.input()
    f.control.access = "view"
    assert.equal((await f.read()).status, 200)
    const count = f.calls.length
    assert.equal((await f.publish(input)).status, 403); assert.equal(f.calls.length, count)
    for (const [report, page] of [["china", "taiwan-price-history"], ["taiwan", "hongkong-price-history"], ["unknown", "pricesetter"]]) {
      assert.equal((await f.read(report, page)).status, 400); assert.equal(f.calls.length, count)
    }
    f.control.auth = "Unauthorized"
    assert.equal((await f.read()).status, 401); assert.equal(f.calls.length, count)
    assert.deepEqual(await f.publications(), [])
  } finally { await f.db.close() }
})

test("invalid stored formulas, circular/missing dependencies and unreadable sources never become blank publications", async () => {
  const f = await setupReportPublicationApp()
  try {
    for (const formula of ["invalid formula", "Missing + 1", "Taichung + 1"]) {
      await f.db.query("update ports set vlsfo_formula=$1 where name='Taichung'", [formula])
      const response = await f.read(); assert.equal(response.status, 503)
      assert.deepEqual(await f.publications(), [])
    }
    await f.db.exec("update ports set vlsfo_formula=null where name='Taichung'")
    for (const key of ["readFailure", "badRead"]) {
      f.control[key] = true
      const response = await f.read(); assert.equal(response.status, 503)
      assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE/); f.control[key] = false
    }
    assert.deepEqual(await f.publications(), [])
  } finally { await f.db.close() }
})

test("database functions deny browser roles and reject malformed service-side commits", async () => {
  const f = await setupReportPublicationApp()
  try {
    for (const role of ["anon", "authenticated"]) {
      await f.db.exec(`reset role;set role ${role}`)
      await assert.rejects(() => f.db.query("select public.read_report_publication_source('taiwan',array['kaohsiung'])"), /permission denied/)
      await assert.rejects(() => f.db.query("select public.publish_report_snapshot('taiwan',array['kaohsiung'],'{}','{}')"), /permission denied/)
    }
    await f.db.exec("reset role;set role service_role")
    await assert.rejects(() => f.db.query("select public.publish_report_snapshot('unknown',array['kaohsiung'],'{}','{}')"), error => error.code === "22023")
    assert.deepEqual(await f.publications(), [])
  } finally { await f.db.close() }
})

test("irrelevant ports and unused fuel formulas do not invalidate a report baseline", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.exec("update ports set hsfo_formula='Dalian + 1' where name='Suao';update ports set vlsfo_formula='Dalian + 1' where name='Hong Kong'")
    const taiwan = await f.input(), hk = await f.input("hongkong")
    await f.db.exec("update ports set hsfo=123,vlsfo=234,mgo=345 where name='Dalian'")
    assert.equal((await f.publish(taiwan)).status, 200)
    assert.equal((await f.publish(hk, "hongkong")).status, 200)
  } finally { await f.db.close() }
})

test("invalid request bodies/dates cannot reach the write RPC; valid date override is preserved", async () => {
  const f = await setupReportPublicationApp()
  try {
    const input = await f.input()
    for (const body of [{ ...input, dateOverride: "2026-02-30" }, { ...input, payload: { rows: [] } }, { ...input, sourceVersion: "" }]) assert.equal((await f.publish(body)).status, 400)
    for (const body of ["{", JSON.stringify({ ...input, x: "é".repeat(3000) })]) {
      const response = await f.route.POST(new Request("http://localhost/api/admin/report-publication?report=taiwan&page=pricesetter", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }))
      assert.equal(response.status, 400)
    }
    assert.equal(f.calls.filter(call => call.name === "publish_report_snapshot").length, 0)
    const response = await f.publish({ ...input, dateOverride: "2026-10-10" })
    assert.equal(response.status, 200); assert.equal((await response.json()).reportDate, "10 Oct 2026")
  } finally { await f.db.close() }
})
