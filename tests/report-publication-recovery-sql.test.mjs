import assert from "node:assert/strict"
import test from "node:test"
import { setupReportPublicationApp } from "./fixtures/report-publication-app.mjs"
import { publicReportReader } from "./fixtures/public-report-reader.mjs"

test("editor can explicitly repair malformed stored JSON after reviewing valid source data", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.query("insert into remarks(id,content) values(103,$1)", ["{broken"])
    const response = await f.read("china"), data = await response.json()
    assert.equal(response.status, 200, JSON.stringify(data))
    assert.equal(data.publishedReportDamaged, true)
    assert.equal(data.publishedReportDate, null)
    assert.equal(data.preview.reportDate, "08 Oct 2026")
    assert.equal((await f.publications())[0].content, "{broken", "loading never repairs implicitly")
    const repaired = await f.publish({ sourceVersion: data.sourceVersion, publicationVersion: data.publicationVersion, dateOverride: "" }, "china")
    assert.equal(repaired.status, 200, await repaired.clone().text())
    const reader = publicReportReader(f.db)
    const publicResponse = await reader.route.GET(new Request("http://localhost/api/reports/china"), { params: Promise.resolve({ key: "china" }) })
    assert.equal(publicResponse.status, 200)
    assert.deepEqual((await publicResponse.json()).snapshot, data.preview)
  } finally { await f.db.close() }
})

test("repair cannot overwrite a changed publication before the request or inside SQL; malformed replay stays read-only", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.query("insert into remarks(id,content) values(101,$1)", ["{broken"])
    const before = await f.input()
    await f.db.query("update remarks set content=$1 where id=101", ["{different damage"])
    assert.equal((await f.publish(before)).status, 409)
    assert.equal((await f.publications())[0].content, "{different damage")
    const reviewed = await f.input()
    f.control.beforeWrite = async () => f.db.query("update remarks set content=$1 where id=101", ["{concurrent damage"])
    assert.equal((await f.publish(reviewed)).status, 409)
    assert.equal((await f.publications())[0].content, "{concurrent damage")
    const retry = await f.input()
    f.control.badWrite = true
    assert.equal((await f.publish(retry)).status, 503)
    const committed = await f.publications()
    f.control.badWrite = false
    const replay = await f.publish(retry)
    assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true)
    assert.deepEqual(await f.publications(), committed)
    const stale = await f.input()
    await f.db.exec("update remarks set content='Updated source' where id=2")
    assert.equal((await f.publish(stale)).status, 409)
    assert.deepEqual(await f.publications(), committed)
  } finally { await f.db.close() }
})

test("damaged report remains intact on View attempts, invalid source, or a failing publication trigger", async () => {
  const f = await setupReportPublicationApp()
  try {
    await f.db.query("insert into remarks(id,content) values(101,$1)", ["{broken"])
    const input = await f.input(), before = await f.publications(), prices = await f.state()
    f.control.access = "view"
    assert.equal((await f.publish(input)).status, 403)
    assert.deepEqual(await f.publications(), before)
    f.control.access = "edit"
    await f.db.exec("update ports set vlsfo_formula='Missing + 1' where name='Taichung'")
    assert.equal((await f.read()).status, 503)
    assert.deepEqual(await f.publications(), before)
    await f.db.exec("update ports set vlsfo_formula=null where name='Taichung';reset role;create function public.fail_repair() returns trigger language plpgsql as $$begin if new.id=101 then raise exception 'PRIVATE repair trigger';end if;return new;end$$;create trigger fail_repair before update on remarks for each row execute function public.fail_repair();set role service_role")
    const failed = await f.publish(await f.input())
    assert.equal(failed.status, 503); assert.doesNotMatch(JSON.stringify(await failed.json()), /PRIVATE/)
    assert.deepEqual(await f.publications(), before); assert.deepEqual(await f.state(), prices)
  } finally { await f.db.close() }
})
