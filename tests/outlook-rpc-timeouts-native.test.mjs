import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { setupNativePricing } from "./fixtures/native-postgres-pricing.mjs"

const migration = readFileSync(new URL("../supabase/migrations/20261016022343_bounded_outlook_verification_rpc_timeouts.sql", import.meta.url), "utf8")
const health = readFileSync(new URL("../lib/systemHealth.ts", import.meta.url), "utf8")
const functions = [
  ["verify_outlook_exchange_truth_ledger", "", true],
  ["verify_outlook_template_recipient_truth", "", true],
  ["save_email_template_canonical", "jsonb,bigint,timestamptz", false],
  ["repair_email_templates_canonical", "jsonb", false],
  ["replace_email_template_library_canonical", "jsonb,text", false],
  ["reserve_outlook_template_insertion", "uuid,text,bigint,uuid,text,text,text,integer", false],
]

test("native scoped Outlook timeout migration preserves every body, privilege and non-target setting", async () => {
  const f = await setupNativePricing()
  try {
    for (const [name, args, definer] of functions) {
      await f.owner.query(`create function public.${name}(${args}) returns jsonb language sql ${definer ? "security definer" : "security invoker"} set search_path='' as $$ select '{"synthetic":true}'::jsonb $$;
        revoke all on function public.${name}(${args}) from public,anon,authenticated;
        grant execute on function public.${name}(${args}) to service_role;`)
    }
    await f.owner.query("create function public.synthetic_unrelated_rpc() returns integer language sql set search_path='' as $$ select 1 $$;")
    const metadata = () => f.owner.one(`select jsonb_build_object('functions',jsonb_agg(jsonb_build_object(
      'name',p.proname,'body',p.prosrc,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig) order by p.proname))
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname in ('${functions.map(([name]) => name).join("','")}') or p.proname='synthetic_unrelated_rpc');`)
    const before = await metadata()
    const rolesBefore = await f.owner.one("select jsonb_build_object('roles',jsonb_agg(jsonb_build_object('name',rolname,'config',rolconfig) order by rolname)) from pg_catalog.pg_roles;")
    await f.owner.query(`begin; ${migration} commit;`)
    const after = await metadata()
    for (const old of before.functions) {
      const next = after.functions.find(item => item.name === old.name)
      if (old.name === "synthetic_unrelated_rpc") assert.deepEqual(next, old)
      else assert.deepEqual(next, { ...old, config: [...old.config, "statement_timeout=20s"] })
    }
    assert.deepEqual(await f.owner.one("select jsonb_build_object('roles',jsonb_agg(jsonb_build_object('name',rolname,'config',rolconfig) order by rolname)) from pg_catalog.pg_roles;"), rolesBefore)
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await f.owner.one(`select jsonb_build_object('allowed',has_function_privilege('${role}','public.verify_outlook_exchange_truth_ledger()','execute'));`)).allowed, false)
    }
    const service = await f.session("scoped-timeout-service")
    assert.deepEqual(await service.one("select public.verify_outlook_exchange_truth_ledger();"), { synthetic: true })
    assert.match(health, /const OUTLOOK_TRUTH_CHECK_TIMEOUT_MS = 25_000/)
    assert.match(health, /checkExchangeTruth, OUTLOOK_TRUTH_CHECK_TIMEOUT_MS/)
    assert.match(health, /checkOutlookTemplateRecipientTruth,\s+OUTLOOK_TRUTH_CHECK_TIMEOUT_MS/)
  } finally { await f.close() }
})
