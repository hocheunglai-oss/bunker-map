import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { setupHourlyVerification, randomUUID, literal, json } from "./fixtures/outlook-hourly-verification-native.mjs"
import { ref, source } from "./fixtures/outlook-template-source-policy.mjs"
import { isCertifiedRecipientProjectionAvailable } from "../lib/outlookRecipientMapAvailability.ts"

const migrationPath = "supabase/migrations/20261023041904_refresh_outlook_certification_before_expiry.sql"
const originalBodyMd5 = "babb4851a5732290c97ec3104c9a704a"
const bound = { id: "template", refs: { to: [ref("one")] } }
const catalog = f => f.owner.one(`select jsonb_agg(jsonb_build_object(
  'oid',p.oid,'name',n.nspname||'.'||p.proname,'args',pg_get_function_identity_arguments(p.oid),
  'source',p.prosrc,'owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
  'language',p.prolang,'volatile',p.provolatile,'securityDefiner',p.prosecdef,
  'strict',p.proisstrict,'parallel',p.proparallel,'result',p.prorettype)
  order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private');`)
const getter = rows => rows.find(row => row.name === "public.get_outlook_template_recipient_refresh_state")
const apply = f => f.owner.query(`begin; ${source(migrationPath)} commit;`)
const withFixture = async (callback, { repaired = true } = {}) => {
  const f = await setupHourlyVerification()
  try {
    const preimage = await f.owner.one("select to_jsonb(md5(prosrc)) from pg_proc where oid='public.get_outlook_template_recipient_refresh_state(uuid)'::regprocedure;")
    assert.equal(preimage, originalBodyMd5, "native fixture must start at the exact read-only verified live body")
    if (repaired) await apply(f)
    await callback(f)
  } finally {
    await f.close()
    assert.equal(existsSync(join(f.data, "postmaster.pid")), false)
    assert.deepEqual(readdirSync(f.socket), [])
  }
}

// Fixture-only clock setup. Production certificates/ledger are immutable; no
// provider data or timestamp is rewritten by the migration being tested.
async function ageCertificate(f, baseline, interval) {
  const at = await f.owner.one(`update public.outlook_exchange_sync_certifications
    set certified_at=clock_timestamp()-interval ${literal(interval)}
    where run_id=${literal(baseline.result.runId)}::uuid returning to_jsonb(certified_at);`)
  await f.setCurrentTruth({ ...baseline.result, certifiedAt: at })
  // Do not bypass the real guard: an expired certificate must not authorize
  // even fixture template writes. The expired boundary needs only map denial.
  if (Date.now() - Date.parse(at) < 36 * 60 * 60 * 1000) {
    await f.owner.query(`update public.email_templates set recipient_resolution=
      jsonb_set(recipient_resolution,'{certifiedAt}',${json(at)});`)
  }
  return at
}
const mapAvailable = async f => {
  const truth = await f.worker.one("select public.verify_outlook_exchange_truth_ledger();")
  return isCertifiedRecipientProjectionAvailable(truth, Date.now(), 36 * 60 * 60)
}

test("proactive migration preserves getter identity, ACL/settings and every other function without writing business state", async () => withFixture(async f => {
  const before = await catalog(f), state = await f.state(), proof = await f.proofState()
  await apply(f)
  const after = await catalog(f)
  assert.notEqual(getter(before).source, getter(after).source)
  assert.deepEqual({ ...getter(after), source: getter(before).source }, getter(before))
  assert.deepEqual(after.filter(row => row.name !== getter(after).name), before.filter(row => row.name !== getter(before).name))
  assert.deepEqual(await f.state(), state)
  assert.deepEqual(await f.proofState(), proof)
}, { repaired: false }))

test("exact body preimage drift rejects the append-only migration and leaves its entire catalog/state unchanged", async () => withFixture(async f => {
  await f.owner.query(`create or replace function public.get_outlook_template_recipient_refresh_state(p_run_id uuid)
    returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp set statement_timeout='20s'
    as $$ begin return '{"syntheticDrift":true}'::jsonb; end; $$;`)
  const before = await catalog(f), state = await f.state(), proof = await f.proofState()
  const writer = await f.session("drift-migration-owner", false)
  await assert.rejects(writer.query(`begin; ${source(migrationPath)} commit;`), error => error.code === "55000" && /OUTLOOK_REFRESH_SOURCE_DRIFT/.test(error.message))
  assert.deepEqual(await catalog(f), before)
  assert.deepEqual(await f.state(), state)
  assert.deepEqual(await f.proofState(), proof)
}, { repaired: false }))

test("a settled certificate below24h stays none; exactly24h and healthy older certificates request full proof without changing TTL", async () => withFixture(async f => {
  const baseline = await f.baseline({ templates: [bound] })
  await f.acquire()
  for (const [age, mode, reasons] of [
    ["23 hours 59 minutes", "none", []],
    ["24 hours", "full", ["certification-refresh-due"]],
    ["29 hours 45 minutes", "full", ["certification-refresh-due"]],
    ["35 hours 59 minutes", "full", ["certification-refresh-due"]],
    ["36 hours 1 minute", "full", ["certification-expired"]],
  ]) {
    const at = await ageCertificate(f, baseline, age)
    const before = await f.proofState(), state = await f.refresh()
    assert.equal(state.mode, mode, age)
    assert.deepEqual(state.reasons, reasons, age)
    assert.equal(new Date(state.certifiedAt).getTime(), new Date(at).getTime())
    assert.deepEqual(await f.proofState(), before)
    assert.equal(await mapAvailable(f), age !== "36 hours 1 minute", age)
  }
}))

test("failed proactive activation retains the still-usable map, certificate, templates, audit and ledger; the next lease retries safely", async () => withFixture(async f => {
  const baseline = await f.baseline({ templates: [bound] })
  const oldAt = await ageCertificate(f, baseline, "29 hours 45 minutes")
  await f.acquire()
  assert.equal((await f.refresh()).mode, "full")
  assert.equal(await mapAvailable(f), true)
  const packet = await f.packet(), before = await f.state(), proof = await f.proofState()
  await f.owner.query(`create function private.synthetic_reject_proactive_activation() returns trigger language plpgsql as $$ begin
    if new.recipient_resolution->>'certificationRunId'=${literal(f.run)} then raise exception 'SYNTHETIC_PROACTIVE_ACTIVATION_FAILED'; end if; return new; end; $$;
    create trigger zz_synthetic_reject_proactive after update on public.email_templates for each row execute function private.synthetic_reject_proactive_activation();`)
  await assert.rejects(f.commitProof(packet, { session: await f.session("failed-proactive-activation") }), /SYNTHETIC_PROACTIVE_ACTIVATION_FAILED/)
  assert.deepEqual(await f.state(), before)
  assert.deepEqual(await f.proofState(), proof)
  assert.equal(await mapAvailable(f), true)
  await f.release(); f.run = randomUUID(); await f.acquire()
  const next = await f.refresh()
  assert.equal(next.mode, "full")
  assert.deepEqual(next.reasons, ["certification-refresh-due"])
  assert.equal(new Date(next.certifiedAt).getTime(), new Date(oldAt).getTime())
  assert.deepEqual(await f.proofState(), proof)
}))

test("successful proactive proof atomically activates current templates once; replay never extends TTL or causes a refresh loop", async () => withFixture(async f => {
  const baseline = await f.baseline({ templates: [bound] })
  await ageCertificate(f, baseline, "29 hours 45 minutes")
  await f.acquire()
  assert.equal((await f.refresh()).mode, "full")
  const packet = await f.packet(), result = await f.commitProof(packet)
  assert.equal(result.certified, true)
  assert.equal(result.atomicTemplateActivation, true)
  assert.equal(result.templateReconciliation.reconciled, true)
  assert.equal((await f.template("template")).recipient_resolution.certificationRunId, result.runId)
  assert.equal(await mapAvailable(f), true)
  assert.equal((await f.refresh()).mode, "none")
  await f.release()
  const before = await f.proofState(), replay = await f.commitProof(packet)
  assert.equal(replay.idempotent, true)
  assert.equal(replay.certifiedAt, result.certifiedAt)
  assert.deepEqual(await f.proofState(), before)
  f.run = randomUUID(); await f.acquire()
  assert.equal((await f.refresh()).mode, "none")
}))

test("a due certificate cannot bypass pending queue or the exact live incremental lease", async () => withFixture(async f => {
  const baseline = await f.baseline({ templates: [bound] })
  await ageCertificate(f, baseline, "29 hours 45 minutes")
  await assert.rejects(f.refresh(f.run, await f.session("no-proactive-lease")), /OUTLOOK_REFRESH_LEASE_REQUIRED/)
  await f.acquire()
  await assert.rejects(f.refresh(randomUUID(), await f.session("wrong-proactive-lease")), /OUTLOOK_REFRESH_LEASE_REQUIRED/)
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='changed@example.invalid' where id='one';")
  const proof = await f.proofState(), pending = await f.refresh()
  assert.equal(pending.mode, "none")
  assert.equal(pending.queueSettled, false)
  assert.deepEqual(pending.reasons, ["queue-not-settled"])
  assert.deepEqual(await f.proofState(), proof)
  await f.settle(randomUUID())
  const settled = await f.refresh()
  assert.equal(settled.mode, "full")
  assert.ok(settled.reasons.includes("source-updated"))
  assert.ok(settled.reasons.includes("certification-refresh-due"))
  await f.owner.query("update public.outlook_exchange_sync_lock set expires_at=clock_timestamp()-interval '1 second';")
  await assert.rejects(f.refresh(f.run, await f.session("expired-proactive-lease")), /OUTLOOK_REFRESH_LEASE_REQUIRED/)
}))

test("proactive renewal still rejects source drift and an unverified source snapshot rather than minting a certificate", async () => withFixture(async f => {
  const baseline = await f.baseline({ templates: [bound] })
  await ageCertificate(f, baseline, "29 hours 45 minutes")
  await f.acquire()
  const packet = await f.packet(), before = await f.proofState()
  await assert.rejects(f.commitProof({ ...packet, rawHash: "b".repeat(64) }, { session: await f.session("bad-proactive-proof") }), /immutable staged raw FCUNO source/)
  assert.deepEqual(await f.proofState(), before)
  await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values('late','SYNTHETIC','late','Late','late@example.invalid');")
  await f.settle(randomUUID())
  const failed = await f.commitProof(packet)
  assert.equal(failed.certified, false)
  assert.match(failed.reason, /high-water changed/)
  assert.equal((await f.proofState()).certifications.length, before.certifications.length)
}))
