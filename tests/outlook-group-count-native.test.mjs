import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { setupNativeCcinfo, waitForBlock, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { outlookGroupsFixtureSql, groupCountMigrationSql } from "./fixtures/outlook-groups-sql.mjs"

const g1 = "synthetic-group-a", g2 = "synthetic-group-b"
const settle = promise => promise.then(value => ({ value }), error => ({ error }))
const add = (contact, group = g1) => `insert into public.shared_addressbook_group_members(group_id,contact_id,source_book) values(${literal(group)},${literal(contact)},'SYNTHETIC');`
const remove = (contact, group = g1) => `delete from public.shared_addressbook_group_members where group_id=${literal(group)} and contact_id=${literal(contact)};`
const state = (f, reader = f.owner) => reader.one(`select jsonb_build_object(
  'groups',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.shared_addressbook_groups t),
  'members',(select coalesce(jsonb_agg(to_jsonb(t) order by group_id,contact_id),'[]') from public.shared_addressbook_group_members t),
  'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
  'queue',(select coalesce(jsonb_agg(to_jsonb(t) order by queue_sequence),'[]') from public.outlook_exchange_sync_queue t),
  'epochs',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t));`)
async function begin(session, { correlation = true, isolation = "read committed" } = {}) {
  assert.ok(["read committed", "repeatable read"].includes(isolation))
  await session.query(`set session characteristics as transaction isolation level ${isolation};`)
  await session.begin()
  const correlationId = randomUUID()
  await session.query(`set local request.headers=${literal(JSON.stringify({ "x-bunker-admin-user": session.label, "x-bunker-admin-page-id": "outlook-addressbook", "x-bunker-audit-action": "native-isolated-verification", "x-bunker-audit-correlation-id": correlationId }))};
    ${correlation ? `set local app.audit_correlation_id=${literal(correlationId)};` : ""}`)
}
async function seed(f, count = 1, secondGroupCount = 0) {
  await f.owner.query(`truncate public.shared_addressbook_group_members,public.shared_addressbook_groups,public.shared_addressbook_contacts,public.outlook_exchange_sync_queue,public.audit_logs restart identity cascade;
    begin; set local request.headers='{"x-bunker-admin-user":"synthetic-seed"}';
    insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email)
      select 'c'||n,'SYNTHETIC','card-'||n,'SYNTHETIC CONTACT '||n,'synthetic-'||n||'@example.invalid' from generate_series(1,6) n;
    insert into public.shared_addressbook_groups(id,source_book,source_uid,name) values
      (${literal(g1)},'SYNTHETIC','immutable-a','GROUP A'),(${literal(g2)},'SYNTHETIC','immutable-b','GROUP B');
    ${Array.from({ length: count }, (_, n) => add(`c${n + 1}`)).join("\n")}
    ${Array.from({ length: secondGroupCount }, (_, n) => add(`c${n + 4}`, g2)).join("\n")}
    commit;
    truncate public.outlook_exchange_sync_queue,public.audit_logs restart identity cascade;
    truncate private.bunker_map_backup_mutations restart identity;`)
  return state(f)
}
function countsMatch(value) {
  for (const group of value.groups) assert.equal(group.member_count, value.members.filter(member => member.group_id === group.id).length)
}
function membershipEvidence(value, changes, epochs = changes, queued = changes) {
  countsMatch(value)
  assert.equal(value.audit.length, changes, "Derived count/version writes must not add human audit noise")
  assert.equal(value.audit.every(row => row.table_name === "shared_addressbook_group_members"), true)
  assert.equal(value.queue.length, queued, "Derived parent writes must not add group sync work")
  assert.equal(value.queue.every(row => row.entity_type === "group_members"), true)
  assert.equal(value.queue.every(row => row.audit_log_id && row.audit_log_ids.includes(row.audit_log_id) && row.change_set_id), true)
  assert.equal(value.epochs.length, epochs, "All nested writes share one durable epoch per committed transaction")
}
async function parallel(f, firstSql, secondSql) {
  const first = await f.session("parallel-first"), second = await f.session("parallel-second"), observer = await f.session("parallel-observer")
  try {
    await begin(first); await first.query(firstSql)
    await begin(second)
    const pending = settle(second.query(secondSql))
    await waitForBlock(observer, second, first, "transactionid")
    await first.query("commit;")
    const result = await pending
    assert.equal(result.error, undefined)
    await second.query("commit;")
    return state(f)
  } finally { await Promise.all([first.close(), second.close(), observer.close()]) }
}
async function mutate(f, sql, label = "single-mutation") {
  const session = await f.session(label)
  try { await begin(session); await session.query(sql); await session.query("commit;") } finally { await session.close() }
  return state(f)
}

test("native PostgreSQL 17.6 RED: installed count-before-lock trigger loses a parallel addition", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(outlookGroupsFixtureSql({ repaired: false }))
  try {
    await seed(f)
    const final = await parallel(f, add("c2"), add("c3"))
    assert.equal(final.members.filter(row => row.group_id === g1).length, 3)
    assert.equal(final.groups.find(row => row.id === g1).member_count, 2)
    t.diagnostic(`RED reproduced with exact old function; fixture SHA-256 ${f.fixtureSha256}`)
  } finally { await f.close() }
})

test("native PostgreSQL 17.6: serialized group counts preserve version/audit/outbox/backup contracts", { timeout: 180000 }, async t => {
  const f = await setupNativeCcinfo(outlookGroupsFixtureSql())
  t.diagnostic(`Owned socket-only cluster ${f.root}; ${f.version}; runtime SHA-256 ${f.runtimeSha256}; fixture SHA-256 ${f.fixtureSha256}`)
  try {
    for (const [name, count, first, second, expected] of [
      ["add/add", 1, add("c2"), add("c3"), 3],
      ["remove/remove", 3, remove("c1"), remove("c2"), 1],
      ["add/remove", 2, add("c3"), remove("c1"), 2],
    ]) await t.test(`parallel ${name} waits without FK lock-upgrade deadlock and recounts after commit`, async () => {
      const initial = await seed(f, count)
      const final = await parallel(f, first, second)
      assert.equal(final.groups.find(row => row.id === g1).member_count, expected)
      assert.notEqual(final.groups[0].updated_at, initial.groups[0].updated_at)
      membershipEvidence(final, 2)
    })

    await t.test("opposite cross-group moves lock both parents in stable order and count each side", async () => {
      const initial = await seed(f, 2, 2)
      const final = await parallel(f,
        `update public.shared_addressbook_group_members set group_id=${literal(g2)} where group_id=${literal(g1)} and contact_id='c1';`,
        `update public.shared_addressbook_group_members set group_id=${literal(g1)} where group_id=${literal(g2)} and contact_id='c4';`)
      assert.deepEqual(final.groups.map(row => row.member_count), [2, 2])
      for (let n = 0; n < 2; n++) assert.notEqual(final.groups[n].updated_at, initial.groups[n].updated_at)
      membershipEvidence(final, 2)
    })

    for (const [name, change, queued] of [
      ["contact identity", "contact_id='c3'", 1],
      ["source book", "source_book='SYNTHETIC SECOND'", 0],
    ]) await t.test(`same-count ${name} UPDATE advances parent epoch without derived group audit/outbox noise`, async () => {
      const initial = await seed(f, 2)
      const final = await mutate(f, `update public.shared_addressbook_group_members set ${change} where group_id=${literal(g1)} and contact_id='c1';`)
      assert.notEqual(final.groups[0].updated_at, initial.groups[0].updated_at)
      assert.equal(final.groups[0].member_count, 2)
      membershipEvidence(final, 1, 1, queued)
      const stale = await f.session("same-count-stale-cas")
      try {
        await begin(stale)
        assert.deepEqual(await stale.one(`with changed as (delete from public.shared_addressbook_groups where id=${literal(g1)} and updated_at=${literal(initial.groups[0].updated_at)} returning *) select coalesce(jsonb_agg(to_jsonb(changed)),'[]') from changed;`), [])
        await stale.query("rollback;")
      } finally { await stale.close() }
    })

    await t.test("held membership update rejects stale parent Save and Delete after waiting", async () => {
      const initial = await seed(f)
      const writer = await f.session("member-before-parent"), stale = await f.session("stale-parent"), observer = await f.session("observe-cas")
      try {
        await begin(writer); await writer.query(add("c2"))
        await begin(stale)
        const pending = settle(stale.one(`with changed as (update public.shared_addressbook_groups set name='STALE' where id=${literal(g1)} and updated_at=${literal(initial.groups[0].updated_at)} returning *) select coalesce(jsonb_agg(to_jsonb(changed)),'[]') from changed;`))
        await waitForBlock(observer, stale, writer, "transactionid")
        await writer.query("commit;")
        assert.deepEqual((await pending).value, [])
        assert.deepEqual(await stale.one(`with changed as (delete from public.shared_addressbook_groups where id=${literal(g1)} and updated_at=${literal(initial.groups[0].updated_at)} returning *) select coalesce(jsonb_agg(to_jsonb(changed)),'[]') from changed;`), [])
        await stale.query("rollback;")
        membershipEvidence(await state(f), 1)
      } finally { await Promise.all([writer.close(), stale.close(), observer.close()]) }
    })

    await t.test("contact and parent FK cascades remain atomic without recreating deleted groups", async () => {
      await seed(f, 2)
      let final = await mutate(f, "delete from public.shared_addressbook_contacts where id='c1';", "contact-cascade")
      countsMatch(final); assert.equal(final.groups[0].member_count, 1)
      assert.equal(final.audit.length, 2); assert.equal(final.queue.length, 2); assert.equal(final.epochs.length, 1)
      final = await mutate(f, `delete from public.shared_addressbook_groups where id=${literal(g1)};`, "parent-cascade")
      assert.equal(final.groups.some(row => row.id === g1), false)
      assert.equal(final.members.some(row => row.group_id === g1), false)
      assert.equal(final.queue.filter(row => row.entity_type === "group" && row.action === "delete_group").length, 1)
      countsMatch(final)
    })

    await t.test("explicit rollback and late outbox failure undo members, parent versions, audit and backup markers", async () => {
      const initial = await seed(f)
      const rollback = await f.session("explicit-rollback")
      try { await begin(rollback); await rollback.query(add("c2")); await rollback.query("rollback;") } finally { await rollback.close() }
      assert.deepEqual(await state(f), initial)
      await f.owner.query(`create function public.synthetic_reject_queue() returns trigger language plpgsql as $$ begin raise exception 'synthetic late outbox failure'; end $$;
        create trigger synthetic_queue_failure before insert on public.outlook_exchange_sync_queue for each row execute function public.synthetic_reject_queue();`)
      const rejected = await f.session("outbox-rejected")
      try { await begin(rejected); await assert.rejects(rejected.query(add("c2")), /synthetic late outbox failure/) } finally { await rejected.close() }
      assert.deepEqual(await state(f), initial)
      await f.owner.query("drop trigger synthetic_queue_failure on public.outlook_exchange_sync_queue; drop function public.synthetic_reject_queue();")
    })

    await t.test("REPEATABLE READ conflicts abort the stale transaction rather than commit an old count", async () => {
      await seed(f)
      const first = await f.session("rr-first"), second = await f.session("rr-stale"), observer = await f.session("rr-observer")
      try {
        await begin(second, { isolation: "repeatable read" }); await second.query("select count(*) from public.shared_addressbook_groups;")
        await begin(first); await first.query(add("c2"))
        const pending = settle(second.query(add("c3")))
        await waitForBlock(observer, second, first, "transactionid")
        await first.query("commit;")
        assert.equal((await pending).error?.code, "40001")
        await second.close()
        const final = await state(f)
        assert.equal(final.members.length, 2); membershipEvidence(final, 1)
      } finally { await Promise.all([first.close(), second.close(), observer.close()]) }
    })

    await t.test("a conflicting multi-statement batch deadlock rolls back the victim's complete audit/outbox/count/epoch state", async () => {
      await seed(f)
      const first = await f.session("batch-first"), second = await f.session("batch-second"), observer = await f.session("batch-observer")
      try {
        await begin(first); await first.query(add("c2"))
        await begin(second); await second.query(add("c4", g2))
        const one = settle(first.query(add("c3", g2)))
        await waitForBlock(observer, first, second, "transactionid")
        const two = settle(second.query(add("c5")))
        const results = await Promise.all([one, two])
        assert.equal(results.filter(result => result.error?.code === "40P01").length, 1)
        const winner = results[0].error ? second : first
        await winner.query("commit;")
        const final = await state(f)
        assert.equal(final.members.length, 3)
        membershipEvidence(final, 2, 1)
        assert.equal(final.audit.every(row => row.actor_id === winner.label), true)
      } finally { await Promise.all([first.close(), second.close(), observer.close()]) }
    })

    await t.test("header-only actor attribution is retained without inventing absent legacy audit linkage", async () => {
      await seed(f)
      const writer = await f.session("header-only-attribution")
      try { await begin(writer, { correlation: false }); await writer.query(add("c2")); await writer.query("commit;") } finally { await writer.close() }
      const final = await state(f)
      countsMatch(final)
      assert.equal(final.audit.length, 1); assert.equal(final.queue.length, 1); assert.equal(final.epochs.length, 1)
      assert.equal(final.audit[0].actor_id, "header-only-attribution")
      assert.equal(final.queue[0].actor_id, "header-only-attribution")
      assert.equal(final.queue[0].audit_log_id, null)
      assert.equal(final.queue[0].change_set_id, null)
      // Existing live-matching audit/outbox boundary, outside the counter fix.
    })

    await t.test("backup fence excludes active writers; bounded migration fails before partial DDL", async () => {
      await seed(f)
      const writer = await f.session("fence-writer"), backup = await f.session("fence-reader"), migrating = await f.session("busy-migration", false)
      try {
        await begin(writer); await writer.query(add("c2"))
        assert.equal((await backup.one("select public.get_bunker_map_backup_export_fence();")).ready, false)
        await assert.rejects(migrating.query(`begin; ${groupCountMigrationSql()} commit;`), error => error.code === "55P03")
        await migrating.close(); await writer.query("commit;")
        assert.equal((await backup.one("select public.get_bunker_map_backup_export_fence();")).ready, true)
        await backup.query("begin; select pg_advisory_xact_lock(730261052372033133::bigint);")
        const blocked = await f.session("backup-busy-migration", false)
        try { await assert.rejects(blocked.query(`begin; ${groupCountMigrationSql()} commit;`), error => error.code === "55P03") } finally { await blocked.close() }
        await backup.query("rollback;")
        membershipEvidence(await state(f), 1)
      } finally { await Promise.all([writer.close(), backup.close(), migrating.close()]) }
    })

    await t.test("selective backfill changes only bad counts; healthy rerun adds no audit/outbox/epoch writes", async () => {
      await seed(f)
      await f.owner.query(`update public.shared_addressbook_groups set member_count=99 where id=${literal(g1)};`)
      const initial = await state(f)
      await f.owner.query(`begin; ${groupCountMigrationSql()} commit;`)
      const repaired = await state(f)
      countsMatch(repaired)
      assert.notEqual(repaired.groups[0].updated_at, initial.groups[0].updated_at)
      assert.equal(repaired.groups[1].updated_at, initial.groups[1].updated_at)
      assert.deepEqual(repaired.audit, initial.audit); assert.deepEqual(repaired.queue, initial.queue)
      assert.equal(repaired.epochs.length, initial.epochs.length + 1)
      await f.owner.query(`begin; ${groupCountMigrationSql()} commit;`)
      assert.deepEqual(await state(f), repaired)
    })

    await t.test("invoker trigger needs no callable ACL, preserves RLS and does not elevate missing parent privileges", async () => {
      await seed(f)
      const identity = await f.owner.one(`select jsonb_build_object('definer',prosecdef,'config',proconfig,'serviceExecute',has_function_privilege('service_role',oid,'EXECUTE'),'anonExecute',has_function_privilege('anon',oid,'EXECUTE'),'authenticatedExecute',has_function_privilege('authenticated',oid,'EXECUTE')) from pg_proc where oid='public.outlook_addressbook_refresh_member_count()'::regprocedure;`)
      assert.equal(identity.definer, false); assert.ok(identity.config.includes('search_path=""'))
      assert.equal(identity.serviceExecute, false); assert.equal(identity.anonExecute, false); assert.equal(identity.authenticatedExecute, false)
      for (const role of ["anon", "authenticated"]) {
        const browser = await f.session(`denied-${role}`, false)
        try { await browser.query(`set role ${role};`); await assert.rejects(browser.query(add("c2")), /permission denied/) } finally { await browser.close() }
      }
      const initial = await state(f)
      await f.owner.query("revoke update on public.shared_addressbook_groups from service_role;")
      const denied = await f.session("denied-parent-write")
      try { await begin(denied); await assert.rejects(denied.query(add("c2")), /permission denied/) } finally { await denied.close() }
      assert.deepEqual(await state(f), initial)
      await f.owner.query("grant update on public.shared_addressbook_groups to service_role;")
      membershipEvidence(await mutate(f, add("c2"), "supported-service-writer"), 1)
    })
  } finally { await f.close(); t.diagnostic("All owned sessions closed and local PostgreSQL stopped; no hosted writes.") }
})
