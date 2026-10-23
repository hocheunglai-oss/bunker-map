import assert from "node:assert/strict"
import test from "node:test"
import { literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { setupPermissionGroups, groupPolicy, memberId, groupMigrationSql } from "./fixtures/admin-permission-groups-native.mjs"

const actualRole = () => `select to_jsonb(permissions->>'__adminRole') from public.admin_users where id=${literal(memberId)};`
const move = role => `update public.admin_users set permissions=jsonb_set(permissions,'{__adminRole}',${literal(JSON.stringify(role))}::jsonb) where id=${literal(memberId)};`
const isError = (code, message) => error => error.code === code && error.message.includes(message)

for (const storage of ["shared-store", "table"]) test(`${storage}: native atomic permission groups preserve authority, CAS, membership and audit`, { timeout: 120000 }, async t => {
  const f = await setupPermissionGroups(storage)
  t.afterEach(async () => { await Promise.all(f.sessions.filter(session => session !== f.owner).map(session => session.close())) })
  try {
    await t.test("service-only invokers and the signed identity implementation remain unchanged", async () => {
      const flags = await f.owner.one(`select jsonb_agg(jsonb_build_object('name',proname,'invoker',not prosecdef,
        'anon',has_function_privilege('anon',oid,'execute'),'authenticated',has_function_privilege('authenticated',oid,'execute'),
        'service',has_function_privilege('service_role',oid,'execute')) order by proname) from pg_proc
        where oid in ('public.read_admin_permission_groups()'::regprocedure,'public.write_admin_permission_group(text,text,jsonb,text)'::regprocedure);`)
      assert.equal(flags.length, 2)
      for (const row of flags) assert.deepEqual({ ...row, name: undefined }, { name: undefined, invoker: true, anon: false, authenticated: false, service: true })
      const hashes = await f.owner.one(`select jsonb_build_object('identity',(select md5(prosrc) from pg_proc where oid='public.fcuno_set_admin_identity_revision()'::regprocedure),
        'outbox',(select md5(prosrc) from pg_proc where oid='public.fcuno_enqueue_identity_sync()'::regprocedure));`)
      assert.deepEqual(hashes, { identity: "364d301fbe2b6e02c3f03b1be3cbbfed", outbox: "375a54c3d0d2ddc5cf756d78b1bfeec9" })
      for (const role of ["anon", "authenticated"]) {
        const denied = await f.session(`read-denied-${role}`, false); await denied.query(`set role ${role};`)
        await assert.rejects(f.readGroups(denied), error => error.code === "42501")
      }
    })
    await t.test("read-only versioned groups use the existing authority and do not create audit or user writes", async () => {
      const before = await f.snapshot(), reader = await f.session("read-only-groups")
      await reader.query("begin read only;")
      const state = await f.readGroups(reader)
      await reader.query("commit;")
      assert.equal(state.storage, storage); assert.equal(state.schema, "fcuno.admin-permission-groups/v1")
      assert.equal(state.groups.length, 6)
      assert.ok(state.groups.every(g => /^[a-f0-9]{64}$/.test(g.version)))
      assert.deepEqual(await f.snapshot(), before)
    })
    await t.test("one group save preserves all users, metadata, credentials, sibling groups and identity events", async () => {
      const before = await f.snapshot(), betaVersion = await f.version("BETA"), writer = await f.session("single-group-save")
      await writer.begin()
      const result = await f.write(writer, "save", "ALPHA", groupPolicy("edit"), await f.version("ALPHA"))
      await writer.query("commit;")
      assert.equal(result.saved, true); assert.equal(result.deleted, false); assert.equal(result.memberCount, 0)
      assert.deepEqual(result.row.permissions, groupPolicy("edit")); assert.equal(result.version, result.row.version)
      assert.equal(await f.version("BETA"), betaVersion)
      const after = await f.snapshot()
      for (const key of ["users", "identityAudit", "outbox"]) assert.deepEqual(after[key], before[key])
      assert.equal(after.audit.length, before.audit.length + 1)
      assert.equal(after.audit.at(-1).request_context.pageId, "user-management")
      if (storage === "shared-store") assert.deepEqual(after.store.find(r => r.key === "admin-permission-groups").payload.retained, { preserve: true })
      else assert.deepEqual(after.store, before.store, "an existing role table remains authoritative")
    })
    await t.test("concurrent different-group saves merge without losing either policy", async () => {
      const alphaVersion = await f.version("ALPHA"), betaVersion = await f.version("BETA")
      const first = await f.session("different-group-first"), second = await f.session("different-group-second"), observer = await f.session("different-group-observer")
      await first.begin(); await second.begin()
      await f.write(first, "save", "ALPHA", groupPolicy("none"), alphaVersion)
      const pending = f.write(second, "save", "BETA", groupPolicy("edit"), betaVersion)
      await waitForBlock(observer, second, first)
      await first.query("commit;"); await pending; await second.query("commit;")
      const groups = (await f.readGroups()).groups
      assert.deepEqual(groups.find(g => g.role === "ALPHA").permissions, groupPolicy("none"))
      assert.deepEqual(groups.find(g => g.role === "BETA").permissions, groupPolicy("edit"))
    })
    await t.test("stale same-group save cannot replace a newer policy or acknowledge success", async () => {
      const oldVersion = await f.version("BETA"), first = await f.session("current-editor")
      await first.begin(); await f.write(first, "save", "BETA", groupPolicy("view"), oldVersion); await first.query("commit;")
      const before = await f.snapshot(), stale = await f.session("stale-editor"); await stale.begin()
      await assert.rejects(f.write(stale, "save", "BETA", groupPolicy("none"), oldVersion), isError("P0001", "ADMIN_PERMISSION_GROUP_CONFLICT"))
      assert.deepEqual(await f.snapshot(), before)
    })
    await t.test("an old direct whole-store or table writer cannot bypass the version fence", async () => {
      const before = await f.snapshot(), legacy = await f.session("legacy-writer"); await legacy.begin()
      const sql = storage === "table" ? "update public.admin_role_defaults set permissions='{}'::jsonb where role='BETA';"
        : "update public.office_calendar_store set payload='{\"groups\":[]}'::jsonb where key='admin-permission-groups';"
      await assert.rejects(legacy.query(sql), isError("P0001", "ADMIN_PERMISSION_GROUP_CONFLICT"))
      assert.deepEqual(await f.snapshot(), before)
    })
    await t.test("concurrent creates of the same absent group have exactly one winner", async () => {
      const first = await f.session("create-first"), second = await f.session("create-second"), observer = await f.session("create-observer")
      await first.begin(); await second.begin()
      await f.write(first, "save", "NEW GROUP", groupPolicy("view"), null)
      const pending = f.write(second, "save", "NEW GROUP", groupPolicy("none"), null)
      await waitForBlock(observer, second, first); await first.query("commit;")
      await assert.rejects(pending, isError("P0001", "ADMIN_PERMISSION_GROUP_CONFLICT"))
      assert.deepEqual((await f.readGroups()).groups.find(g => g.role === "NEW GROUP").permissions, groupPolicy("view"))
    })
    await t.test("a committed join makes a waiting delete fail, including legacy database role columns", async () => {
      const joiner = await f.session("join-before-delete"), deleter = await f.session("delete-after-join"), observer = await f.session("join-delete-observer")
      await joiner.begin(); await joiner.query(move("ALPHA")); await deleter.begin()
      const pending = f.write(deleter, "delete", "ALPHA", null, await f.version("ALPHA"))
      await waitForBlock(observer, deleter, joiner); await joiner.query("commit;")
      await assert.rejects(pending, isError("P0001", "ADMIN_PERMISSION_GROUP_IN_USE"))
      assert.equal(await f.owner.one(actualRole()), "ALPHA")
      const restore = await f.session("restore-role"); await restore.begin(); await restore.query(move("BT")); await restore.query("commit;")
    })
    await t.test("a committed delete makes a waiting stale join fail rather than resurrect a deleted group", async () => {
      const deleter = await f.session("delete-before-join"), joiner = await f.session("join-after-delete"), observer = await f.session("delete-join-observer")
      await deleter.begin(); await f.write(deleter, "delete", "ALPHA", null, await f.version("ALPHA")); await joiner.begin()
      const pending = joiner.query(move("ALPHA"))
      await waitForBlock(observer, joiner, deleter); await deleter.query("commit;")
      await assert.rejects(pending, isError("P0001", "ADMIN_PERMISSION_GROUP_CONFLICT"))
      assert.equal(await f.owner.one(actualRole()), "BT")
      assert.equal((await f.readGroups()).groups.some(g => g.role === "ALPHA"), false)
    })
    await t.test("unrelated attendance, email and credential edits do not acquire the group mutation lock", async () => {
      const holder = await f.session("held-group-lock"), editor = await f.session("unrelated-user-edit")
      await holder.begin(); await holder.query("select pg_advisory_xact_lock(hashtextextended('fcuno:admin-permission-groups:v1',0));")
      await editor.begin(); await editor.query("set local statement_timeout='1s';")
      await editor.query(`update public.admin_users set permissions=jsonb_set(permissions,'{__attendanceGroup}','\"AC\"'::jsonb),email='changed@example.invalid',password_hash='synthetic-new' where id=${literal(memberId)};`)
      await editor.query("commit;"); await holder.query("rollback;")
      assert.equal(await f.owner.one(actualRole()), "BT")
      const row = (await f.snapshot()).users[0]
      assert.equal(row.permissions.__attendanceGroup, "AC"); assert.equal(row.password_hash, "synthetic-new")
    })
    await t.test("audit suppression or a required policy write failure rolls back the entire operation", async () => {
      await f.owner.query(`create function private.suppress_group_audit() returns trigger language plpgsql as $$ begin return null; end $$;
        create trigger suppress_group_audit before insert on public.audit_logs for each row execute function private.suppress_group_audit();`)
      const before = await f.snapshot(), writer = await f.session("suppressed-group-audit"); await writer.begin()
      try {
        await assert.rejects(f.write(writer, "save", "BETA", groupPolicy("none"), await f.version("BETA")), isError("P0001", "ADMIN_PERMISSION_GROUP_NOT_SAVED"))
        assert.deepEqual(await f.snapshot(), before)
      } finally { await f.owner.query("drop trigger suppress_group_audit on public.audit_logs;") }
    })
    await t.test("group audit preserves prior context and restores attribution for the next mutation in the same transaction", async () => {
      const writer = await f.session("composed-group-audit"), prior = { action: "owner-operation", correlationMarker: "preserve-this" }
      await writer.begin()
      await writer.query(`select set_config('app.audit_context',${literal(JSON.stringify(prior))},true);`)
      await f.write(writer, "save", "BETA", groupPolicy("edit"), await f.version("BETA"))
      assert.deepEqual(await writer.one("select current_setting('app.audit_context')::jsonb;"), prior)
      await writer.query(`insert into public.office_calendar_store(key,payload) values('event-calendar','{"composed":true}'::jsonb);`)
      await writer.query("commit;")
      const logs = (await f.snapshot()).audit
      const composedLogs = logs.filter(row => row.request_context.correlationMarker === "preserve-this")
      assert.equal(composedLogs.length, 2, "both same-transaction audits must preserve the original marker")
      const groupLog = composedLogs.find(row => row.record_pk.role === "BETA" || row.record_pk.key === "admin-permission-groups")
      assert.equal(groupLog.request_context.action, "permission-group-save")
      const nextLog = composedLogs.find(row => row.record_pk.key === "event-calendar")
      assert.equal(nextLog.request_context.action, "owner-operation")
      assert.equal(nextLog.request_context.correlationMarker, "preserve-this")
    })
    await t.test("built-in deletion and unknown errors are not converted into successful mutations", async () => {
      const builtin = await f.session("built-in-delete"); await builtin.begin()
      const before = await f.snapshot()
      await assert.rejects(f.write(builtin, "delete", "BT", null, await f.version("BT")), isError("P0001", "ADMIN_PERMISSION_GROUP_BUILT_IN"))
      assert.deepEqual(await f.snapshot(), before)
    })
  } finally { await f.close() }
})

for (const [name, fault, marker] of [
  ["unexpected schema", "alter table public.admin_users rename column permissions to old_permissions;", "ADMIN_PERMISSION_GROUP_SCHEMA_MISMATCH"],
  ["unexpected identity source", "create or replace function public.fcuno_set_admin_identity_revision() returns trigger language plpgsql as $$ begin return new; end $$;", "ADMIN_PERMISSION_GROUP_IDENTITY_SOURCE_MISMATCH"],
  ["noncanonical legacy metadata", `update public.admin_users set permissions=jsonb_set(permissions,'{__adminRole}','\" bt \"'::jsonb);`, "ADMIN_PERMISSION_GROUP_LEGACY_REVIEW_REQUIRED"],
]) test(`native migration preflight: ${name} rolls back all new functions and leaves source data unchanged`, { timeout: 120000 }, async () => {
  const f = await setupPermissionGroups("shared-store", { corrected: false })
  try {
    await f.owner.query(fault)
    const before = await f.snapshot(), migrator = await f.session("preflight-migrator", false)
    await assert.rejects(migrator.query(`begin; ${groupMigrationSql()} commit;`), isError("55000", marker))
    assert.equal(await f.owner.one("select to_jsonb(to_regprocedure('public.write_admin_permission_group(text,text,jsonb,text)') is null);"), true)
    assert.equal(await f.owner.one("select to_jsonb(to_regprocedure('private.admin_effective_permission_group(text,jsonb)') is null);"), true)
    assert.deepEqual(await f.snapshot(), before)
  } finally { await f.close() }
})

for (const [storage, name, fault, marker] of [
  ["shared-store", "numeric role is not silently converted to text", `update public.office_calendar_store set payload=jsonb_set(payload,'{groups,0,role}','42'::jsonb) where key='admin-permission-groups';`, "ADMIN_PERMISSION_GROUP_STORAGE_INVALID"],
  ["shared-store", "malformed timestamp", `update public.office_calendar_store set payload=jsonb_set(payload,'{groups,0,updatedAt}','"not-a-date"'::jsonb) where key='admin-permission-groups';`, "ADMIN_PERMISSION_GROUP_STORAGE_INVALID"],
  ["shared-store", "invalid calendar date", `update public.office_calendar_store set payload=jsonb_set(payload,'{groups,0,updatedAt}','"2026-02-30T00:00:00Z"'::jsonb) where key='admin-permission-groups';`, "ADMIN_PERMISSION_GROUP_STORAGE_INVALID"],
  ["table", "non-finite table timestamp", "update public.admin_role_defaults set updated_at='infinity'::timestamptz where role='ALPHA';", "ADMIN_PERMISSION_GROUP_STORAGE_INVALID"],
  ["shared-store", "JS-noncanonical Unicode group", `update public.office_calendar_store set payload=jsonb_set(payload,'{groups,0,role}','"ß"'::jsonb) where key='admin-permission-groups';`, "ADMIN_PERMISSION_GROUP_LEGACY_REVIEW_REQUIRED"],
  ["table", "JS-noncanonical Unicode table group", "update public.admin_role_defaults set role='ß' where role='ALPHA';", "ADMIN_PERMISSION_GROUP_LEGACY_REVIEW_REQUIRED"],
]) test(`native migration preflight: ${storage} ${name} rejects before session readers become available`, { timeout: 120000 }, async () => {
  const f = await setupPermissionGroups(storage, { corrected: false })
  try {
    await f.owner.query(fault)
    const before = await f.snapshot(), migrator = await f.session("preflight-invalid-group", false)
    await assert.rejects(migrator.query(`begin; ${groupMigrationSql()} commit;`), isError("55000", marker))
    assert.equal(await f.owner.one("select to_jsonb(to_regprocedure('public.read_admin_permission_groups()') is null);"), true)
    assert.equal(await f.owner.one("select to_jsonb(to_regprocedure('private.admin_permission_group_rows()') is null);"), true)
    assert.deepEqual(await f.snapshot(), before)
  } finally { await f.close() }
})
