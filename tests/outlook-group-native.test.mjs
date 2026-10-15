import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { setupNativeCcinfo, waitForBlock, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { groupCountMigrationSql } from "./fixtures/outlook-groups-sql.mjs"

const schema = readFileSync(new URL("../supabase/shared_address_book.sql", import.meta.url), "utf8")
const outbox = readFileSync(new URL("../supabase/migrations/20260722045125_exchange_sync_transactional_outbox.sql", import.meta.url), "utf8")
const start = outbox.indexOf("create or replace function public.outlook_addressbook_touch_updated_at()")
const end = outbox.indexOf("drop trigger if exists outlook_exchange_queue_contact", start)
assert.ok(start > 0 && end > start)
// Existing version/FK definitions plus the reviewed append-only counter repair.
// Full audit/outbox/backup proofs live in outlook-group-count-native.test.mjs.
const fixture = `create role anon; create role authenticated; create role service_role bypassrls;
${schema}\n${outbox.slice(start, end)}
grant all on public.shared_addressbook_contacts, public.shared_addressbook_groups, public.shared_addressbook_group_members to service_role;
begin; ${groupCountMigrationSql()} commit;`
const id = "group-native-synthetic"
const update = version => `with changed as (update public.shared_addressbook_groups set name='EDITED' where id=${literal(id)} and updated_at=${literal(version)}::timestamptz returning *) select coalesce(jsonb_agg(to_jsonb(changed)),'[]'::jsonb) from changed;`
const remove = version => `with changed as (delete from public.shared_addressbook_groups where id=${literal(id)} and updated_at=${literal(version)}::timestamptz returning *) select coalesce(jsonb_agg(to_jsonb(changed)),'[]'::jsonb) from changed;`
const settle = promise => promise.then(value => ({ value }), error => ({ error }))
const state = f => f.owner.one(`select jsonb_build_object('groups',(select coalesce(jsonb_agg(to_jsonb(g)),'[]') from public.shared_addressbook_groups g),'members',(select coalesce(jsonb_agg(to_jsonb(m)),'[]') from public.shared_addressbook_group_members m));`)
async function seed(f) {
  await f.owner.query(`delete from public.shared_addressbook_groups; delete from public.shared_addressbook_contacts;
    insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values ('contact-one','SYNTHETIC','one','CONTACT ONE','one@example.invalid'),('contact-two','SYNTHETIC','two','CONTACT TWO','two@example.invalid');
    insert into public.shared_addressbook_groups(id,source_book,source_uid,name) values (${literal(id)},'SYNTHETIC','immutable-source','ORIGINAL');
    insert into public.shared_addressbook_group_members(group_id,contact_id,source_book) values (${literal(id)},'contact-one','SYNTHETIC');`)
  return (await state(f)).groups[0]
}

test("native PostgreSQL 17.6: repaired Outlook group versions fence deletes, saves and member mutations", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(fixture)
  t.diagnostic(`Owned native cluster ${f.root}; ${f.version}; runtime SHA-256 ${f.runtimeSha256}; fixture SHA-256 ${f.fixtureSha256}`)
  try {
    await t.test("delete-first: held UPDATE resumes with zero rows and cannot resurrect the FK-cascaded group", async () => {
      const initial = await seed(f)
      const deleting = await f.session("delete-first"), saving = await f.session("save-after-delete"), observer = await f.session("observe-delete")
      await deleting.begin(); assert.equal((await deleting.one(remove(initial.updated_at))).length, 1)
      await saving.begin()
      const pending = settle(saving.one(update(initial.updated_at)))
      await waitForBlock(observer, saving, deleting, "transactionid")
      await deleting.query("commit;")
      const result = await pending
      assert.equal(result.error, undefined)
      assert.deepEqual(result.value, [])
      await saving.query("commit;")
      assert.deepEqual(await state(f), { groups: [], members: [] })
      await Promise.all([deleting.close(), saving.close(), observer.close()])
    })

    await t.test("save-first: a stale delete cannot delete the new group version or its members", async () => {
      const initial = await seed(f)
      const saving = await f.session("save-first"), deleting = await f.session("delete-after-save"), observer = await f.session("observe-save")
      await saving.begin()
      const changed = await saving.one(update(initial.updated_at))
      assert.equal(changed.length, 1)
      assert.notEqual(changed[0].updated_at, initial.updated_at)
      assert.equal(changed[0].source_uid, "immutable-source")
      await deleting.begin()
      const pending = settle(deleting.one(remove(initial.updated_at)))
      await waitForBlock(observer, deleting, saving, "transactionid")
      await saving.query("commit;")
      const result = await pending
      assert.equal(result.error, undefined); assert.deepEqual(result.value, [])
      await deleting.query("commit;")
      const final = await state(f)
      assert.equal(final.groups[0].name, "EDITED")
      assert.equal(final.members.length, 1)
      await Promise.all([saving.close(), deleting.close(), observer.close()])
    })

    for (const action of ["add", "remove"]) await t.test(`${action} member-first: repaired derived-count trigger advances the parent and rejects stale metadata/deletion`, async () => {
      const initial = await seed(f)
      const member = await f.session(`member-${action}`), stale = await f.session(`metadata-after-${action}`), observer = await f.session(`observe-${action}`)
      await member.begin()
      await member.query(action === "add"
        ? `insert into public.shared_addressbook_group_members(group_id,contact_id,source_book) values (${literal(id)},'contact-two','SYNTHETIC');`
        : `delete from public.shared_addressbook_group_members where group_id=${literal(id)} and contact_id='contact-one';`)
      await stale.begin()
      const pending = settle(stale.one(action === "add" ? update(initial.updated_at) : remove(initial.updated_at)))
      await waitForBlock(observer, stale, member, "transactionid")
      await member.query("commit;")
      const result = await pending
      assert.equal(result.error, undefined); assert.deepEqual(result.value, [])
      await stale.query("commit;")
      const final = await state(f)
      assert.notEqual(final.groups[0].updated_at, initial.updated_at)
      assert.equal(final.groups[0].name, "ORIGINAL")
      assert.equal(final.groups[0].member_count, action === "add" ? 2 : 0)
      assert.equal(final.members.length, action === "add" ? 2 : 0)
      await Promise.all([member.close(), stale.close(), observer.close()])
    })
  } finally { await f.close(); t.diagnostic("All owned sessions closed and local PostgreSQL stopped.") }
})
