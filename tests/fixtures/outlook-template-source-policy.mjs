import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { outlookGroupsFixtureSql } from "./outlook-groups-sql.mjs"
import { setupNativeCcinfo } from "./native-postgres-ccinfo.mjs"
import { truth, resolution, fn, literal, json, certification, fingerprint } from "./outlook-insertion-native.mjs"

export { literal, json, certification, fingerprint }
export const migrationPath = "supabase/migrations/20261022040757_propagate_outlook_source_recipient_changes.sql"
export const source = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const between = (value, from, to) => {
  const a = value.indexOf(from), b = value.indexOf(to, a)
  assert.ok(a >= 0 && b > a, `Missing actual fixture section ${from}`)
  return value.slice(a, b)
}

// Actual source audit/outbox/count/version/canonical guards and reservation.
// Actual source/queue ledger writer and SHA chain use PostgreSQL17's built-in
// SHA-256 for the same byte digest; no provider or business data is involved.
// The expensive hosted Exchange projection verifier alone is supplied as
// explicit synthetic truth. This is not a database recovery rehearsal.
export async function setupSourcePolicy({ repaired = true } = {}) {
  const ledger = source("supabase/migrations/20260723080326_exchange_truth_ledger.sql")
  const state = source("supabase/migrations/20260723141044_outlook_insertion_audit_state_machine.sql")
  const canonical = source("supabase/migrations/20260723120428_outlook_template_canonical_writes.sql")
  const hardening = source("supabase/migrations/20260723124045_harden_outlook_template_truth_writes.sql")
  const verified = truth({ operationallyConsistent: true })
  const fixture = await setupNativeCcinfo(`
    ${outlookGroupsFixtureSql()}
    create schema extensions;
    create function extensions.digest(bytea,text) returns bytea language sql immutable as $$ select case when $2='sha256' then pg_catalog.sha256($1) else null end $$;
    ${between(ledger, "create table if not exists public.outlook_exchange_truth_snapshots (", "create or replace function public.reject_outlook_exchange_truth_mutation()")}
    ${fn(ledger, "public.record_outlook_exchange_queue_truth")}
    create trigger outlook_exchange_truth_queue after insert or update on public.outlook_exchange_sync_queue for each row execute function public.record_outlook_exchange_queue_truth();
    ${source("supabase/email_templates.sql").replace('create extension if not exists "pgcrypto";', "")}
    ${between(state, "drop index if exists", "create or replace function public.reserve_outlook_template_insertion(")}
    ${between(canonical, "create or replace function public.email_templates_manage_version()", "create or replace function public.email_template_library_revision()")}
    ${fn(canonical, "public.save_email_template_canonical")}
    ${fn(source("supabase/migrations/20260723141037_certify_outlook_group_smtp_truth.sql"), "public.is_valid_outlook_template_recipient_resolution")}
    ${fn(source("supabase/migrations/20260724054502_split_outlook_certification_template_reconciliation.sql"), "public.reconcile_outlook_template_recipient_ref")}
    ${fn(source("supabase/migrations/20260723121704_enforce_outlook_template_recipient_truth.sql"), "public.reconcile_outlook_template_recipient_array")}
    ${fn(source("supabase/migrations/20260723121704_enforce_outlook_template_recipient_truth.sql"), "public.reconcile_outlook_template_resolution")}
    create table private.synthetic_exchange_truth(value jsonb not null);
    insert into private.synthetic_exchange_truth values (${json(verified)});
    create function public.verify_outlook_exchange_truth_ledger() returns jsonb language sql stable security definer set search_path='' as $$ select value from private.synthetic_exchange_truth $$;
    ${between(hardening, "create or replace function private.prepare_outlook_template_truth_write()", "create or replace function public.verify_outlook_template_recipient_truth()")}
    ${source("supabase/migrations/20261016021744_keep_certified_template_writes_available_during_sync.sql")}
    ${source("supabase/migrations/20261022024949_bound_outlook_insertion_reservation_verification.sql")}
    grant usage on schema private to service_role;
    select public.audit_enable_table('public.email_templates');
    grant select,insert,update,delete on public.email_templates to service_role;
    grant select,insert on public.audit_logs to service_role;
    grant execute on function public.save_email_template_canonical(jsonb,bigint,timestamptz) to service_role;
    set request.headers='{"x-bunker-admin-user":"synthetic-owner","x-bunker-admin-page-id":"outlookaddressbook"}';
  `)
  try {
    fixture.verified = verified
    const session = fixture.session
    fixture.session = async (...args) => {
      const client = await session(...args)
      await client.query(`set request.headers=${literal(JSON.stringify({ "x-bunker-admin-user": args[0], "x-bunker-admin-page-id": "outlookaddressbook" }))};`)
      return client
    }
    fixture.template = (id = "synthetic-template", reader = fixture.owner) => reader.one(`select to_jsonb(t) from public.email_templates t where id=${literal(id)};`)
    fixture.state = () => fixture.owner.one(`select jsonb_build_object(
      'contacts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.shared_addressbook_contacts t),
      'groups',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.shared_addressbook_groups t),
      'members',(select coalesce(jsonb_agg(to_jsonb(t) order by group_id,contact_id),'[]') from public.shared_addressbook_group_members t),
      'templates',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.email_templates t),
      'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
      'queue',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.outlook_exchange_sync_queue t),
      'ledger',(select coalesce(jsonb_agg(to_jsonb(t) order by ledger_sequence),'[]') from public.outlook_exchange_truth_ledger t));`)
    fixture.certify = async (run = certification) => {
      await fixture.owner.query(`select public.append_outlook_exchange_truth_event(${literal(`certification:${run}`)},'full_certification',clock_timestamp(),${literal(run)}::uuid,null,null,null,'{}');`)
      if (run !== certification) {
        fixture.verified = { ...fixture.verified, latestCertificationRunId: run, latestCertificationAt: new Date().toISOString() }
        await fixture.owner.query(`update private.synthetic_exchange_truth set value=${json(fixture.verified)};`)
      }
    }
    fixture.seed = async ({ contacts = [], groups = [], members = [], templates = [] } = {}) => {
      for (const contact of contacts) await fixture.owner.query(`insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values (${literal(contact.id)},'SYNTHETIC',${literal(contact.id)},${literal(contact.name || contact.id)},${literal(contact.email || `${contact.id}@example.invalid`)});`)
      for (const group of groups) await fixture.owner.query(`insert into public.shared_addressbook_groups(id,source_book,source_uid,name) values (${literal(group.id)},'SYNTHETIC',${literal(group.id)},${literal(group.name || group.id)});`)
      for (const member of members) await fixture.owner.query(`insert into public.shared_addressbook_group_members(group_id,contact_id,source_book) values (${literal(member.group)},${literal(member.contact)},'SYNTHETIC');`)
      await fixture.certify()
      for (const template of templates) {
        const id = template.id || "synthetic-template", refs = { to: [], cc: [], bcc: [], ...template.refs }
        const all = Object.values(refs).flat()
        const evidence = { ...resolution(fixture.verified), refs, counts: { total: all.length, resolved: all.filter(r => r.status === 'resolved').length, external: all.filter(r => r.status === 'external').length, missing: all.filter(r => r.status === 'missing').length, ambiguous: all.filter(r => r.status === 'ambiguous').length } }
        await fixture.owner.query(`insert into public.email_templates(id,title,subject,folder,body_html,body_text,slug,is_active,to_recipients,cc_recipients,bcc_recipients,revision,recipient_resolution) values (${literal(id)},'Synthetic template','Unchanged subject','Synthetic','<p>Unchanged body</p>','Unchanged body',${literal(id)},true,${literal(template.to ?? refs.to.map(r => r.literal).join('; '))},${literal(template.cc ?? refs.cc.map(r => r.literal).join('; '))},${literal(template.bcc ?? refs.bcc.map(r => r.literal).join('; '))},1,${json(evidence)});`)
      }
    }
    fixture.apply = () => fixture.owner.query(`begin; ${source(migrationPath)} commit;`)
    if (repaired) await fixture.apply()
    return fixture
  } catch (error) { await fixture.close(); throw error }
}

export function ref(id, { field = "to", position = 0, kind = "contact", name = id, address = `${id}@example.invalid`, literal: text, status = "resolved" } = {}) {
  return { field, position, kind, sourceId: kind === "external" || kind === "unresolved" ? null : id,
    displayName: name, sourceValue: address,
    literal: text || `${name} <${address}>`, status,
    resolvedAddress: status === "missing" ? null : address }
}

export const reserve = (operation, template, revision, run = certification) => `select public.reserve_outlook_template_insertion(${literal(operation)}::uuid,${literal(template)},${revision},${literal(run)}::uuid,${literal(fingerprint)},'synthetic-user','Synthetic User',129600);`
