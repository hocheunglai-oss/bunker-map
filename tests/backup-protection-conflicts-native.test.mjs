import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"
import { gapFixtureSql, gapCorrectionSql, observation, gap } from "./fixtures/backup-protection-gaps-sql.mjs"

const signature = "public.reconcile_backup_protection_gaps(text,timestamptz,jsonb,boolean)"
const marker = "BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED"
const call = (time = observation) => `select public.reconcile_backup_protection_gaps('drive-file',${literal(time)}::timestamptz,${literal(JSON.stringify([gap("opaque-file")]))}::jsonb,true);`
const snapshot = f => f.owner.one(`select jsonb_build_object(
  'parents',(select coalesce(jsonb_agg(to_jsonb(t) order by domain),'[]') from private.backup_protection_observations t),
  'gaps',(select coalesce(jsonb_agg(to_jsonb(t) order by domain,gap_key),'[]') from private.backup_protection_gaps t));`)
const metadata = f => f.owner.one(`select to_jsonb(p) - 'prosrc' - 'xmin' from pg_proc p where oid=${literal(signature)}::regprocedure;`)
const body = f => f.owner.one(`select to_jsonb(prosrc) from pg_proc where oid=${literal(signature)}::regprocedure;`)

test("native backup observation guard correction preserves identity, all four rollback branches and engine errors", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(gapFixtureSql({ corrected: false }))
  try {
    const original = await body(f), originalMetadata = await metadata(f)
    const originalDefinition = await f.owner.one(`select to_jsonb(pg_get_functiondef(${literal(signature)}::regprocedure));`)
    assert.equal(createHash("md5").update(original).digest("hex"), "f55faf7c1c31453776872e37799c48c1")
    const baseline = await f.session("baseline-success-proof")
    await baseline.query("begin;")
    const originalReply = await baseline.one(call())
    await baseline.query("rollback;")
    await f.owner.query(`begin; ${gapCorrectionSql()} commit;`)
    await t.test("same OID, owner, volatility, invoker, signature, ACL and settings; only four fixed guard errors differ", async () => {
      assert.deepEqual(await metadata(f), originalMetadata)
      assert.equal(original.match(/errcode = '40001'/g)?.length, 4)
      const expected = original.replaceAll("errcode = '40001'", `errcode = 'P0001', detail = '${marker}'`)
      assert.equal(await body(f), expected)
      const grants = await f.owner.one(`select jsonb_build_object('service',has_function_privilege('service_role',${literal(signature)},'execute'),
        'anon',has_function_privilege('anon',${literal(signature)},'execute'),'authenticated',has_function_privilege('authenticated',${literal(signature)},'execute'));`)
      assert.deepEqual(grants, { service: true, anon: false, authenticated: false })
    })
    await t.test("the success acknowledgement and persisted clocks are unchanged", async () => {
      const writer = await f.session("corrected-success-proof")
      assert.deepEqual(await writer.one(call()), originalReply)
      const saved = await snapshot(f)
      assert.equal(saved.parents.length, 1); assert.equal(saved.gaps.length, 1)
      assert.equal(saved.gaps[0].gap_key, "opaque-file")
    })
    const guards = [
      ["missing initial parent", "backup_protection_observations", "insert", "return null;", false, "Backup protection observation was not saved."],
      ["altered initial parent", "backup_protection_observations", "insert", "new.last_observed_at := new.last_observed_at + interval '1 hour'; return new;", false, "Backup protection observation was not saved."],
      ["suppressed child write", "backup_protection_gaps", "insert", "return null;", false, "Backup protection gaps were not reconciled."],
      ["suppressed parent acknowledgement", "backup_protection_observations", "update", "return null;", true, "Backup protection observation was not saved."],
    ]
    for (const [name, table, operation, action, seed, message] of guards) await t.test(name, async () => {
      await f.owner.query("truncate private.backup_protection_gaps,private.backup_protection_observations;")
      if (seed) { const seedWriter = await f.session(`seed-${operation}`); assert.equal((await seedWriter.one(call())).accepted, true) }
      await f.owner.query(`create or replace function private.guard_fault() returns trigger language plpgsql as $$ begin ${action} end $$;
        create trigger guard_fault before ${operation} on private.${table} for each row execute function private.guard_fault();`)
      const before = await snapshot(f), writer = await f.session(`unconfirmed-${name}`)
      try {
        await assert.rejects(writer.one(call(seed ? "2026-10-14T01:00:00Z" : observation)), error => {
          assert.equal(error.code, "P0001")
          assert.ok(error.message.includes(message))
          assert.match(error.message, /DETAIL:\s+BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED(?:\n|$)/)
          return true
        })
        assert.deepEqual(await snapshot(f), before, "a rejected write cannot advance, create, clear or reset any protection clock")
      } finally { await f.owner.query(`drop trigger guard_fault on private.${table};`) }
    })
    await t.test("a genuine serializable concurrent-update failure remains native 40001", async () => {
      await f.owner.query("truncate private.backup_protection_gaps,private.backup_protection_observations;")
      const seed = await f.session("serialization-seed")
      await seed.one(call())
      const first = await f.session("serialization-first"), second = await f.session("serialization-second")
      for (const session of [first, second]) {
        await session.query("begin isolation level serializable;")
        assert.equal(await session.one("select to_jsonb(count(*)) from private.backup_protection_observations;"), 1)
      }
      await first.one(call("2026-10-14T01:00:00Z")); await first.query("commit;")
      const committed = await snapshot(f)
      await assert.rejects(second.one(call("2026-10-14T02:00:00Z")), error => {
        assert.equal(error.code, "40001")
        assert.match(error.message, /could not serialize access due to concurrent update/)
        assert.doesNotMatch(error.message, /BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED/)
        return true
      })
      assert.deepEqual(await snapshot(f), committed)
    })
    await t.test("underlying trigger error codes and unknown P0001 propagate unchanged and roll back", async () => {
      for (const code of ["40001", "P0001", "23514"]) {
        await f.owner.query(`create or replace function private.engine_fault() returns trigger language plpgsql as $$ begin
          raise exception 'SYNTHETIC_UNRELATED_DATABASE_ERROR' using errcode='${code}',detail='PRIVATE_DIAGNOSTIC'; end $$;
          create trigger engine_fault before insert on private.backup_protection_gaps for each row execute function private.engine_fault();
          truncate private.backup_protection_gaps,private.backup_protection_observations;`)
        const before = await snapshot(f), writer = await f.session(`engine-${code}`)
        await assert.rejects(writer.one(call()), error => {
          assert.equal(error.code, code); assert.match(error.message, /SYNTHETIC_UNRELATED_DATABASE_ERROR/)
          assert.doesNotMatch(error.message, /BACKUP_PROTECTION_OBSERVATION_UNCONFIRMED/); return true
        })
        assert.deepEqual(await snapshot(f), before)
        await f.owner.query("drop trigger engine_fault on private.backup_protection_gaps;")
      }
    })
    await t.test("source drift rejects the append-only migration before replacement or data changes", async () => {
      assert.ok(originalDefinition.includes("$function$"))
      await f.owner.query(originalDefinition.replace("$function$", "$function$\n-- synthetic competing function revision\n") + ";")
      const changedBody = await body(f), changedMetadata = await metadata(f), before = await snapshot(f)
      const migrator = await f.session("source-drift-migrator", false)
      await assert.rejects(migrator.query(`begin; ${gapCorrectionSql()} commit;`), error => error.code === "55000" && error.message.includes("BACKUP_PROTECTION_OBSERVATION_SOURCE_MISMATCH"))
      assert.equal(await body(f), changedBody)
      assert.deepEqual(await metadata(f), changedMetadata)
      assert.deepEqual(await snapshot(f), before)
    })
  } finally { await f.close() }
})
