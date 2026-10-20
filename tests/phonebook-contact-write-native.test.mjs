import assert from "node:assert/strict"
import test from "node:test"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { phonebookSql, contactId } from "./fixtures/phonebook-company-save-sql.mjs"

const current = (db, id = contactId(1)) => db.owner.one(`select to_jsonb(c) from public.phonebook_contacts c where id=${literal(id)};`)
const compareAndSet = (id, revision, mobile = "+85299990000") => `with changed as (update public.phonebook_contacts set mobile_1=${literal(mobile)} where id=${literal(id)} and updated_at=${literal(revision)}::timestamptz returning *) select coalesce(jsonb_agg(to_jsonb(changed)),'[]') from changed;`
const evidence = db => db.owner.one("select jsonb_build_object('contacts',(select jsonb_agg(to_jsonb(c) order by id) from public.phonebook_contacts c),'queue',(select coalesce(jsonb_agg(to_jsonb(q) order by contact_id),'[]') from public.phonebook_carddav_queue q),'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.audit_logs a));")

test("native contact revision uses now() trigger; successful CAS returns the new row and stale/missing CAS changes nothing", async () => {
  const db = await setupNativeCcinfo(phonebookSql())
  try {
    const revisionTrigger = await db.owner.one("select jsonb_build_object('definition',pg_get_triggerdef(t.oid),'function',pg_get_functiondef(t.tgfoid)) from pg_trigger t where t.tgrelid='public.phonebook_contacts'::regclass and t.tgname='set_phonebook_contacts_updated_at';")
    assert.match(revisionTrigger.definition, /BEFORE UPDATE/)
    assert.match(revisionTrigger.function, /new.updated_at=now\(\)/)
    const before = await current(db), writer = await db.session("contact-cas")
    await writer.begin("SYNTHETIC CONTACT EDITOR")
    const changed = await writer.one(compareAndSet(before.id, before.updated_at))
    assert.equal(changed.length, 1)
    assert.equal(changed[0].mobile_1, "+85299990000")
    assert.notEqual(changed[0].updated_at, before.updated_at)
    assert.equal(changed[0].source_key, before.source_key)
    assert.equal(changed[0].created_at, before.created_at)
    await writer.query("commit;")
    const after = await evidence(db)
    assert.equal(after.queue.length, 1)
    assert.equal(after.audit.length, 1)
    assert.deepEqual(await writer.one(compareAndSet(before.id, before.updated_at, "STALE")), [])
    assert.deepEqual(await writer.one(compareAndSet(contactId(99), before.updated_at, "MISSING")), [])
    assert.deepEqual(await evidence(db), after, "zero-row writes add no audit or durable CardDAV work")
  } finally { await db.close() }
})

test("native exact timestamp CAS distinguishes microseconds that a JS Date would collapse", async () => {
  const db = await setupNativeCcinfo(phonebookSql())
  try {
    await db.owner.query("alter table public.phonebook_contacts disable trigger set_phonebook_contacts_updated_at; update public.phonebook_contacts set updated_at='2026-10-20T12:00:00.123456Z' where id=" + literal(contactId(1)) + "; alter table public.phonebook_contacts enable trigger set_phonebook_contacts_updated_at;")
    const writer = await db.session("microsecond-cas")
    assert.deepEqual(await writer.one(compareAndSet(contactId(1), "2026-10-20T12:00:00.123457+00:00")), [])
    const changed = await writer.one(compareAndSet(contactId(1), "2026-10-20T20:00:00.123456+08:00"))
    assert.equal(changed.length, 1)
    assert.equal(changed[0].mobile_1, "+85299990000")
  } finally { await db.close() }
})

test("native concurrent contact writers recheck revision after the row lock and preserve the first colleague update", async () => {
  const db = await setupNativeCcinfo(phonebookSql())
  try {
    const before = await current(db), first = await db.session("first-colleague"), second = await db.session("stale-editor")
    await first.begin(); await second.begin()
    const winner = await first.one(compareAndSet(before.id, before.updated_at, "+85297770000"))
    assert.equal(winner.length, 1)
    const pending = second.one(compareAndSet(before.id, before.updated_at, "+85298880000")); pending.catch(() => undefined)
    await waitForBlock(db.owner, second, first, "transactionid")
    await first.query("commit;")
    assert.deepEqual(await pending, [])
    await second.query("commit;")
    assert.equal((await current(db)).mobile_1, "+85297770000")
    const result = await evidence(db)
    assert.equal(result.queue.length, 1)
    assert.equal(result.audit.length, 1)
  } finally { await db.close() }
})

test("native Undo-create DELETE only returns/deletes the unchanged saved revision", async () => {
  const db = await setupNativeCcinfo(phonebookSql())
  try {
    const before = await current(db), writer = await db.session("undo-create-cas")
    const updated = (await writer.one(compareAndSet(before.id, before.updated_at)))[0]
    const remove = revision => `with removed as (delete from public.phonebook_contacts where id=${literal(before.id)} and updated_at=${literal(revision)}::timestamptz returning *) select coalesce(jsonb_agg(to_jsonb(removed)),'[]') from removed;`
    const after = await evidence(db)
    assert.deepEqual(await writer.one(remove(before.updated_at)), [])
    assert.deepEqual(await evidence(db), after)
    const removed = await writer.one(remove(updated.updated_at))
    assert.equal(removed.length, 1)
    assert.equal(removed[0].id, before.id)
    assert.deepEqual(await writer.one(remove(updated.updated_at)), [])
    const result = await evidence(db)
    assert.equal(result.contacts.some(row => row.id === before.id), false)
    assert.equal(result.queue[0].contact_id, before.id, "the deleted ID remains durable work without a source-row foreign key")
    assert.notEqual(result.queue[0].version, after.queue[0].version)
    const restored = await writer.one(`with restored as (insert into public.phonebook_contacts(id,full_name,company,company_source_id,source_key,favorite,mobile_1,created_at) values (${literal(before.id)},${literal(before.full_name)},${literal(before.company)},${literal(before.company_source_id)},${literal(before.source_key)},false,${literal(before.mobile_1)},${literal(before.created_at)}::timestamptz) returning *) select to_jsonb(restored) from restored;`)
    assert.equal(restored.source_key, before.source_key)
    assert.equal(restored.created_at, before.created_at)
    assert.notEqual(restored.updated_at, before.updated_at)
    assert.notEqual(restored.updated_at, updated.updated_at)
  } finally { await db.close() }
})
