import assert from "node:assert/strict"
import test from "node:test"
import { performance } from "node:perf_hooks"
import { setupAtomicEligibility, source, literal } from "./fixtures/outlook-atomic-eligibility-native.mjs"
import { seedRealisticActivationVolume } from "./fixtures/outlook-atomic-eligibility-volume.mjs"

const migration = "supabase/migrations/20261028042019_index_outlook_snapshot_validation.sql"
const indexName = "outlook_exchange_truth_invalid_snapshot_v1_idx"
const legacySignature = "public.verify_outlook_exchange_truth_ledger_without_group_smtp_guard()"
const wrapperSignature = "public.verify_outlook_exchange_truth_ledger()"
const validatorSignature = "public.outlook_exchange_truth_snapshot_is_valid(text,text,integer,text,bigint,jsonb)"
const proof = f => f.owner.one("select public.verify_outlook_exchange_truth_ledger();")
const metadata = f => f.owner.one(`select jsonb_build_object(
  'functions',(select jsonb_object_agg(p.oid::regprocedure::text,to_jsonb(p))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private')),
  'snapshotColumns',(select jsonb_agg(to_jsonb(a)order by attnum)from pg_attribute a where attrelid='public.outlook_exchange_truth_snapshots'::regclass),
  'snapshotTable',(select to_jsonb(c)-'relpages'-'reltuples'-'relallvisible'-'relhasindex'from pg_class c where oid='public.outlook_exchange_truth_snapshots'::regclass));`)
const state = f => f.owner.one(`select jsonb_build_object(
  'templates',(select jsonb_build_object('count',count(*),'sha',md5(string_agg(md5(to_jsonb(t)::text),''order by id)))from public.email_templates t),
  'audit',(select jsonb_build_object('count',count(*),'sha',md5(string_agg(md5(to_jsonb(t)::text),''order by id)))from public.audit_logs t),
  'ledger',(select jsonb_build_object('count',count(*),'sha',md5(string_agg(md5(to_jsonb(t)::text),''order by ledger_sequence)))from public.outlook_exchange_truth_ledger t),
  'certifications',(select jsonb_build_object('count',count(*),'sha',md5(string_agg(md5(to_jsonb(t)::text),''order by run_id)))from public.outlook_exchange_sync_certifications t),
  'queue',(select jsonb_build_object('count',count(*),'sha',md5(string_agg(md5(to_jsonb(t)::text),''order by id)))from public.outlook_exchange_sync_queue t));`)

// One private, socket-only native PostgreSQL17.6 cluster. All contacts, templates,
// history and corruptions below are synthetic; no live source or cloud access.
test("snapshot-validation index retains complete history and atomic activation guarantees", async t => {
  const f = await setupAtomicEligibility({ baseline: false })
  try {
    const { volume, packet } = await seedRealisticActivationVolume(f)
    await f.owner.query("begin;" + source("supabase/migrations/20261023081749_bound_atomic_outlook_full_proof_budget.sql") + "commit;")
    const beforeMetadata = await metadata(f)
    const originalProof = await proof(f)
    const originalLegacy = await f.owner.one(`select to_jsonb(pg_get_functiondef(${literal(legacySignature)}::regprocedure));`)
    let indexedLegacy
    const measurements = []
    const activate = async (label, daily = false) => {
      const before = await state(f)
      await f.owner.query("begin;set local track_functions='all';update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()+interval'120 seconds'" + (daily ? ",sync_mode='full'" : "") + ";")
      const value = daily ? { ...packet, summary: { ...packet.summary, executionMode: "full", readOnlyVerification: false } } : packet
      const started = performance.now()
      const result = await f.commitProof(value, { session: f.owner, atomicFull: daily })
      const elapsedMs = performance.now() - started
      const calls = await f.owner.one("select coalesce(jsonb_agg(jsonb_build_object('name',funcname,'calls',calls,'totalMs',total_time)),'[]')from pg_stat_xact_user_functions;")
      assert.equal(result.certified, true)
      assert.equal(result.atomicTemplateActivation, true)
      assert.equal(result.executionMode, daily ? "full" : "incremental")
      assert.equal(result.readOnlyVerification, !daily)
      assert.equal(result.templateReconciliation.updatedTemplates, 485)
      assert.equal(calls.find(row => row.name === "verify_outlook_exchange_truth_ledger")?.calls, 2)
      assert.equal(calls.find(row => row.name === "verify_outlook_exchange_truth_ledger_without_group_smtp_guard")?.calls, 2)
      await f.owner.query("rollback;")
      assert.deepEqual(await state(f), before)
      measurements.push({ label, elapsedMs, proofCalls: 2,
        shaCalls: calls.find(row => row.name === "outlook_exchange_truth_sha256")?.calls,
        snapshotValidatorCalls: calls.find(row => row.name === "outlook_exchange_truth_snapshot_is_valid")?.calls })
      return calls
    }

    await t.test("realistic original atomic baseline executes both full proofs and rolls back all writes", async () => {
      await activate("original")
    })

    await t.test("migration preserves columns, all function identities and privileges, and complete proof output", async () => {
      await f.owner.query("begin;" + source(migration) + "commit;")
      indexedLegacy = await f.owner.one(`select to_jsonb(pg_get_functiondef(${literal(legacySignature)}::regprocedure));`)
      const after = await metadata(f)
      assert.deepEqual(after.snapshotColumns, beforeMetadata.snapshotColumns)
      assert.deepEqual(after.snapshotTable, beforeMetadata.snapshotTable)
      assert.deepEqual(Object.keys(after.functions).sort(), Object.keys(beforeMetadata.functions).sort())
      const changed = []
      for (const [signature, original] of Object.entries(beforeMetadata.functions)) {
        const actual = after.functions[signature]
        if (actual.prosrc !== original.prosrc) changed.push(original.proname)
        assert.deepEqual({ ...actual, prosrc: original.prosrc }, original, signature)
      }
      assert.deepEqual(changed.sort(), ["verify_outlook_exchange_truth_ledger", "verify_outlook_exchange_truth_ledger_without_group_smtp_guard"])
      assert.deepEqual(await proof(f), originalProof)
    })

    await t.test("optimized whole activation retains every SHA call and both fresh-byte proofs", async () => {
      await activate("indexed")
      assert.equal(measurements[1].shaCalls, measurements[0].shaCalls)
      assert.equal(measurements[0].snapshotValidatorCalls, 151)
      assert.equal(measurements[1].snapshotValidatorCalls, 1)
      const plan = JSON.parse((await f.owner.query(`explain(format json)select snapshot_sha256,created_at from public.outlook_exchange_truth_snapshots where not public.outlook_exchange_truth_snapshot_is_valid(snapshot_sha256,snapshot_kind,schema_version,canonical_json,byte_length,item_counts)order by created_at,snapshot_sha256 limit 1;`)).join("\n"))
      assert.match(JSON.stringify(plan), new RegExp(indexName))
      t.diagnostic(JSON.stringify({ schema: "fcuno.snapshot-validation-index-native/v1", volume, measurements,
        limitation: "Native synthetic hardware timing is not a hosted timing or database-restart cure claim. All original stored-byte hashing remains." }))
    })

    await t.test("daily atomic wrapper retains full mode, certification receipt and rollback", async () => {
      await activate("indexed-daily", true)
    })

    const historicalTarget = "snapshot_sha256=(select snapshot_sha256 from public.outlook_exchange_truth_snapshots where snapshot_kind='fcuno_raw'and canonical_json like '%syntheticHistoryVersion%'order by created_at,snapshot_sha256 limit 1)"
    const freshOriginal = async () => {
      await f.owner.query(originalLegacy + ";set enable_indexscan=off;set enable_indexonlyscan=off;set enable_bitmapscan=off;")
      const result = await proof(f)
      await f.owner.query(indexedLegacy + ";reset enable_indexscan;reset enable_indexonlyscan;reset enable_bitmapscan;")
      return result
    }
    for (const [label, mutation] of [
      ["item counts", `item_counts=item_counts||'{"contacts":1}'`],
      ["schema version", "schema_version=2"],
      ["snapshot kind", "snapshot_kind='fcuno_exchange_projection'"],
      ["canonical bytes", "canonical_json=canonical_json||' '"],
      ["byte length", "byte_length=byte_length+1"],
      ["invalid shape with correctly recomputed SHA", "canonical_json='{\"schema\":\"fcuno.addressbook.raw/v1\",\"contacts\":[],\"groups\":[],\"members\":[],\"unexpected\":true}',snapshot_sha256=public.outlook_exchange_truth_sha256('{\"schema\":\"fcuno.addressbook.raw/v1\",\"contacts\":[],\"groups\":[],\"members\":[],\"unexpected\":true}'),byte_length=octet_length('{\"schema\":\"fcuno.addressbook.raw/v1\",\"contacts\":[],\"groups\":[],\"members\":[],\"unexpected\":true}'),item_counts='{\"contacts\":0,\"groups\":0,\"members\":0}'"],
    ]) {
      await t.test("disabled-trigger historical corruption: " + label, async () => {
        // Owner-only fixture corruption deliberately removes CHECK constraints;
        // real application roles cannot perform this bypass. Index maintenance
        // must continue despite disabled user triggers and removed checks.
        await f.owner.query(`begin;alter table public.outlook_exchange_truth_snapshots disable trigger user;
          do $$declare r record;begin for r in select conname from pg_constraint where conrelid='public.outlook_exchange_truth_snapshots'::regclass and contype='c'loop execute format('alter table public.outlook_exchange_truth_snapshots drop constraint %I',r.conname);end loop;end;$$;
          update public.outlook_exchange_truth_snapshots set ${mutation} where ${historicalTarget};`)
        const actual = await proof(f)
        assert.deepEqual(actual, await freshOriginal())
        assert.equal(actual.snapshotsValid, false)
        assert.equal(actual.valid, false)
        await f.owner.query("rollback;")
        assert.deepEqual(await proof(f), originalProof)
      })
    }

    await t.test("earliest invalid snapshot ordering is unchanged across hash and structure branches", async () => {
      await f.owner.query(`begin;alter table public.outlook_exchange_truth_snapshots disable trigger user;
        update public.outlook_exchange_truth_snapshots set item_counts=item_counts||'{"contacts":1}'where snapshot_sha256 in(select snapshot_sha256 from public.outlook_exchange_truth_snapshots where canonical_json like '%syntheticHistoryVersion%'order by created_at,snapshot_sha256 limit 2);
        update public.outlook_exchange_truth_snapshots set canonical_json=replace(canonical_json,'syntheticHistoryVersion','syntheticHistoryVersioN')where ${historicalTarget};`)
      const actual = await proof(f)
      assert.equal(actual.snapshotsValid, false)
      assert.deepEqual(actual, await freshOriginal())
      await f.owner.query("rollback;")
    })

    await t.test("planner sequential fallback preserves proof correctness", async () => {
      await f.owner.query("set enable_indexscan=off;set enable_indexonlyscan=off;set enable_bitmapscan=off;")
      assert.deepEqual(await proof(f), originalProof)
      await f.owner.query("reset enable_indexscan;reset enable_indexonlyscan;reset enable_bitmapscan;")
    })

    for (const [label, mutation] of [
      ["missing", `drop index public.${indexName};`],
      ["invalid", `update pg_catalog.pg_index set indisvalid=false where indexrelid='public.${indexName}'::regclass;`],
      ["not ready", `update pg_catalog.pg_index set indisready=false where indexrelid='public.${indexName}'::regclass;`],
      ["wrong predicate", `drop index public.${indexName};create index ${indexName} on public.outlook_exchange_truth_snapshots(created_at,snapshot_sha256)where false;`],
    ]) {
      await t.test("fails closed for index " + label + "; rollback restores proof", async () => {
        const actor = await f.session("index-" + label, false)
        await assert.rejects(actor.query("begin;" + mutation + "select public.verify_outlook_exchange_truth_ledger();"), error => error.code === "55000" && /OUTLOOK_SNAPSHOT_INDEX_DRIFT/.test(error.message))
        assert.deepEqual(await proof(f), originalProof)
      })
    }

    await t.test("validator semantic replacement cannot silently reuse its old partial index", async () => {
      const actor = await f.session("validator-drift", false)
      await assert.rejects(actor.query(`begin;create or replace function public.outlook_exchange_truth_snapshot_is_valid(p_snapshot_sha256 text,p_snapshot_kind text,p_schema_version integer,p_canonical_json text,p_byte_length bigint,p_item_counts jsonb)returns boolean language sql immutable set search_path=pg_catalog,pg_temp as $$select true$$;select public.verify_outlook_exchange_truth_ledger();`), error => error.code === "55000" && /OUTLOOK_SNAPSHOT_VALIDATOR_DRIFT/.test(error.message))
      assert.deepEqual(await proof(f), originalProof)
    })

    await t.test("second full proof rejects same-transaction historical mutation and rolls back every activation write", async () => {
      await f.owner.query(`alter table public.outlook_exchange_truth_snapshots disable trigger user;
        create function private.synthetic_mutate_after_template_rows()returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$begin
          update public.outlook_exchange_truth_snapshots set item_counts=item_counts||'{"contacts":1}'where ${historicalTarget};return null;end;$$;
        create trigger zzz_synthetic_mutation after update on public.email_templates for each statement execute function private.synthetic_mutate_after_template_rows();
        update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()+interval'120 seconds';`)
      const before = await state(f)
      await assert.rejects(f.commitProof(packet, { session: await f.session("post-row-corruption") }), /did not settle|TRUTH_UNAVAILABLE|TRUTH_INVALID/)
      assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger zzz_synthetic_mutation on public.email_templates;drop function private.synthetic_mutate_after_template_rows();alter table public.outlook_exchange_truth_snapshots enable trigger user;")
      assert.deepEqual(await proof(f), originalProof)
    })

    await t.test("reapplying the migration fails before mutation and preserves installed state", async () => {
      const before = await metadata(f), actor = await f.session("migration-replay", false)
      await assert.rejects(actor.query("begin;" + source(migration) + "commit;"), error => error.code === "55000" && /OUTLOOK_SNAPSHOT_INDEX_SOURCE_DRIFT/.test(error.message))
      assert.deepEqual(await metadata(f), before)
    })
  } finally {
    await f.close()
  }
})
