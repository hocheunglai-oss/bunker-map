import assert from "node:assert/strict"
import test from "node:test"
import { setupSaveConflicts, companySql, remarksSql, change, source, migrationPath } from "./fixtures/phonebook-taiwan-cas.mjs"

const rejects = (operation, detail, message) => assert.rejects(operation, error => {
  assert.equal(error.code, "P0001")
  assert.match(error.message, new RegExp(`ERROR:\\s+P0001: ${message.replaceAll(".", "\\.")}(?:\\n|$)`))
  assert.match(error.message, new RegExp(`DETAIL:  ${detail}(?:\\n|$)`))
  return true
})

test("native phonebook saved-version conflicts preserve companies, contacts, queue and audit atomically", { timeout: 120000 }, async t => {
  const f = await setupSaveConflicts()
  try {
    for (const [name, sql] of [
      ["stale microsecond baseline", companySql("2026-10-14T00:00:00.123455+00:00")],
      ["removed company", companySql(undefined, undefined, "99999999-9999-4999-8999-999999999999")],
    ]) await t.test(name, async () => {
      const before = await f.snapshot()
      await rejects(f.execute(sql), "PHONEBOOK_COMPANY_CONFLICT", "The company changed or was removed. Reopen it.")
      assert.deepEqual(await f.snapshot(), before)
    })
    await t.test("successful atomic rename keeps permanent identities and queues its three contacts", async () => {
      const before = await f.snapshot(), result = await f.execute(companySql()), after = await f.snapshot()
      assert.equal(result.company.source_key, before.companies[0].source_key)
      assert.notEqual(result.company.updated_at, before.companies[0].updated_at)
      assert.equal(result.contactIds.length, 3)
      assert.equal(after.audit.length, 4)
      assert.deepEqual(after.queue.map(row => row.contact_id), result.contactIds)
      for (let i = 0; i < 3; i++) {
        assert.equal(after.contacts[i].company, "RENAMED COMPANY")
        for (const key of ["id", "source_key", "company_source_id", "mobile_1", "notes"]) assert.equal(after.contacts[i][key], before.contacts[i][key])
      }
      assert.deepEqual(after.contacts[3], before.contacts[3])
    })
  } finally { await f.close() }
})

test("native Taiwan baseline, suppressed write, audit receipt and final-readback guards are distinct typed nonretryable errors", { timeout: 120000 }, async t => {
  const f = await setupSaveConflicts()
  try {
    const cases = [
      ["baseline conflict before any requested write", "", [change(1,"NO PARTIAL SAVE"), change(2,"LOSER","STALE")], "TAIWAN_REMARKS_CONFLICT", "The saved remarks changed. Keep the draft and reload."],
      ["suppressed second write rolls back the first", "create function private.synthetic_notice_write() returns trigger language plpgsql as $$ begin if new.id=2 then return null;end if;return new;end $$;create trigger z_fault before update on public.remarks for each row execute function private.synthetic_notice_write();", [change(1,"FIRST"),change(2,"SECOND")], "TAIWAN_REMARKS_UNCONFIRMED", "The remark save could not be confirmed."],
      ["suppressed audit receipt rolls back every notice", "create function private.synthetic_notice_audit() returns trigger language plpgsql as $$ begin return null;end $$;create trigger z_fault before insert on public.audit_logs for each row execute function private.synthetic_notice_audit();", [change(1,"FIRST"),change(2,"SECOND")], "TAIWAN_REMARKS_UNCONFIRMED", "The remark audit could not be confirmed. No changes were saved."],
      ["late final readback catches an earlier notice altered by a later row", "create function private.synthetic_notice_late() returns trigger language plpgsql as $$ begin if new.id=2 and pg_trigger_depth()=1 then update public.remarks set content='LATE ALTERATION' where id=1;end if;return new;end $$;create trigger zz_late_notice after update on public.remarks for each row execute function private.synthetic_notice_late();", [change(1,"FIRST"),change(2,"SECOND")], "TAIWAN_REMARKS_UNCONFIRMED", "The remark save could not be confirmed."],
    ]
    for (const [name, setup, changes, detail, message] of cases) await t.test(name, async () => {
      if (setup) await f.owner.query(setup)
      try {
        const before = await f.snapshot()
        await rejects(f.execute(remarksSql(changes)), detail, message)
        assert.deepEqual(await f.snapshot(), before)
      } finally {
        await f.owner.query("drop trigger if exists z_fault on public.remarks;drop trigger if exists z_fault on public.audit_logs;drop trigger if exists zz_late_notice on public.remarks;")
      }
    })
    await t.test("successful Save preserves publication, prices and report date; lost-ack replay stays read-only", async () => {
      const before = await f.snapshot()
      const result = await f.execute(remarksSql([change(1,"MEMO\nSECOND LINE"), change(2,"NOTICE\nSECOND NOTICE"), change(3,'{"active":false}',null,false)]))
      assert.equal(result.replayed, false)
      assert.deepEqual(result.rows.map(row => row.id), [1,2,3])
      const after = await f.snapshot()
      for (const key of ["ports","history","publications","companies","contacts","queue"]) assert.deepEqual(after[key], before[key])
      assert.equal(after.remarks.find(row => row.id === 101).content, "UNCHANGED PUBLISHED REMARK")
      assert.equal(after.audit.length, 3)
      assert.equal((await f.execute(remarksSql([change(1,"MEMO\nSECOND LINE"), change(2,"NOTICE\nSECOND NOTICE"), change(3,'{"active":false}',null,false)]))).replayed, true)
      assert.deepEqual(await f.snapshot(), after)
    })
  } finally { await f.close() }
})

test("native two-function migration preserves OIDs, settings and ACLs and changes only five classified guards", { timeout: 120000 }, async () => {
  const f = await setupSaveConflicts()
  try {
    assert.deepEqual(await f.identities(), f.beforeIdentities)
    const after = await f.bodies()
    assert.equal(after.save_phonebook_company, f.beforeBodies.save_phonebook_company.replace("errcode='40001',message='The company changed or was removed. Reopen it.'", "errcode='P0001',message='The company changed or was removed. Reopen it.',detail='PHONEBOOK_COMPANY_CONFLICT'"))
    let expected = f.beforeBodies.save_taiwan_remarks
    expected = expected.replace("errcode='40001',message='The saved remarks changed. Keep the draft and reload.'", "errcode='P0001',message='The saved remarks changed. Keep the draft and reload.',detail='TAIWAN_REMARKS_CONFLICT'")
    expected = expected.replaceAll("errcode='40001',message='The remark save could not be confirmed.'", "errcode='P0001',message='The remark save could not be confirmed.',detail='TAIWAN_REMARKS_UNCONFIRMED'")
    expected = expected.replace("errcode='40001',message='The remark audit could not be confirmed. No changes were saved.'", "errcode='P0001',message='The remark audit could not be confirmed. No changes were saved.',detail='TAIWAN_REMARKS_UNCONFIRMED'")
    assert.equal(after.save_taiwan_remarks, expected)
    for (const identity of await f.identities()) assert.deepEqual([identity.invoker, identity.anon, identity.authenticated, identity.service], [true,false,false,true])
    for (const role of ["anon","authenticated"]) {
      const denied = await f.session(`denied-${role}`, false)
      try { await assert.rejects(denied.query(`set role ${role};${remarksSql([change()])}`), error => error.code === "42501") }
      finally { await denied.close() }
    }
  } finally { await f.close() }
})

test("native migration refuses independently changed source before replacing either function", { timeout: 120000 }, async () => {
  const f = await setupSaveConflicts({ repaired: false })
  try {
    const definition = await f.owner.one("select to_jsonb(pg_get_functiondef('public.save_taiwan_remarks(jsonb)'::regprocedure));")
    await f.owner.query(`${definition.replace("AS $function$\n", () => "AS $function$\n-- synthetic source drift\n")};`)
    const before = await f.bodies(), identities = await f.identities(), migration = await f.session("migration-owner", false)
    try { await assert.rejects(migration.query(`begin;${source(migrationPath)}commit;`), error => error.code === "55000" && /PHONEBOOK_TAIWAN_SAVE_SOURCE_MISMATCH/.test(error.message)) }
    finally { await migration.close() }
    assert.deepEqual(await f.bodies(), before)
    assert.deepEqual(await f.identities(), identities)
  } finally { await f.close() }
})
