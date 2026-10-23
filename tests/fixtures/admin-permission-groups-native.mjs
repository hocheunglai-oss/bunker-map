import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { setupNativeCcinfo, literal } from "./native-postgres-ccinfo.mjs"

export const groupMigration = "supabase/migrations/20261022113511_atomic_admin_permission_groups.sql"
export const groupMigrationSql = () => readFileSync(new URL(`../../${groupMigration}`, import.meta.url), "utf8")
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
function identityFunction(name) {
  const source = read("supabase/migrations/20260831090000_fcuno_identity_federation.sql")
  const start = source.indexOf(`create or replace function public.${name}()`)
  assert.ok(start >= 0)
  return source.slice(start, source.indexOf("$$;", start) + 3)
}
export const groupPages = ["user-management", "attendance-record"]
export const groupPolicy = value => Object.fromEntries(groupPages.map(p => [p, value]))
export const memberId = "10000000-0000-4000-8000-000000000001"
export async function setupPermissionGroups(storage = "shared-store", { corrected = true, beforeMigration = "" } = {}) {
  assert.ok(["table", "shared-store"].includes(storage))
  const groups = ["ADMIN", "AC", "BT", "VN", "ALPHA", "BETA"].map(role => ({ role, permissions: groupPolicy("view"), updatedAt: "2026-10-22T01:00:00.123456Z" }))
  const auditSource = read("supabase/audit_log.sql").split("-- Record Outlook template insertion as an append-only two-phase audit stream.")[0]
    .replace('create extension if not exists "pgcrypto";', "")
  const f = await setupNativeCcinfo(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create schema private;grant usage on schema public,private to service_role;
    create table public.admin_users(id uuid primary key,username text not null,display_name text,email text,email_verified boolean not null default true,
      role text not null,permissions jsonb not null,password_hash text not null default 'synthetic-only',password_reset_required boolean not null default false,
      is_active boolean not null default true,use_fcos boolean not null default true,use_spc boolean not null default true,
      identity_revision bigint not null default 3,credential_revision bigint not null default 2,revoked_before timestamptz,
      updated_at timestamptz not null default now(),created_at timestamptz not null default now());
    create table public.office_calendar_store(key text primary key,payload jsonb not null,updated_at timestamptz not null default now());
    create table public.fcuno_identity_sync_outbox(admin_user_id uuid,identity_revision bigint,payload jsonb,unique(admin_user_id,identity_revision));
    create table public.fcuno_identity_audit(id uuid default gen_random_uuid(),admin_user_id uuid,event_type text,details jsonb);
    insert into public.admin_users(id,username,role,permissions) values(${literal(memberId)},'synthetic-member','user',
      ${literal(JSON.stringify({ ...groupPolicy("view"), __adminRole: "BT", __attendanceGroup: "BS", __preserve: { nested: true } }))}::jsonb);
    insert into public.office_calendar_store(key,payload) values('admin-permission-groups',
      ${literal(JSON.stringify({ groups, retained: { preserve: true } }))}::jsonb),('unrelated-calendar','{"unchanged":true}'::jsonb);
    ${storage === "table" ? `create table public.admin_role_defaults(role text primary key,permissions jsonb not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
      insert into public.admin_role_defaults(role,permissions,updated_at) select item->>'role',item->'permissions',(item->>'updatedAt')::timestamptz from jsonb_array_elements(${literal(JSON.stringify(groups))}::jsonb) item;
      grant select,insert,update,delete on public.admin_role_defaults to service_role;alter table public.admin_role_defaults enable row level security;` : ""}
    grant select,insert,update,delete on public.admin_users,public.office_calendar_store to service_role;
    grant select,insert on public.fcuno_identity_sync_outbox,public.fcuno_identity_audit to service_role;
    alter table public.admin_users enable row level security;alter table public.office_calendar_store enable row level security;
    ${identityFunction("fcuno_set_admin_identity_revision")}
    ${identityFunction("fcuno_enqueue_identity_sync")}
    create trigger fcuno_set_admin_identity_revision before insert or update on public.admin_users for each row execute function public.fcuno_set_admin_identity_revision();
    create trigger fcuno_enqueue_identity_sync after insert or update on public.admin_users for each row execute function public.fcuno_enqueue_identity_sync();
    ${auditSource}
    ${beforeMigration}
    ${corrected ? groupMigrationSql() : ""}
  `)
  const snapshot = () => f.owner.one(`select jsonb_build_object(
    'store',(select jsonb_agg(to_jsonb(t) order by key) from public.office_calendar_store t),
    'users',(select jsonb_agg(to_jsonb(t) order by id) from public.admin_users t),
    'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
    'identityAudit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.fcuno_identity_audit t),
    'outbox',(select coalesce(jsonb_agg(to_jsonb(t) order by admin_user_id,identity_revision),'[]') from public.fcuno_identity_sync_outbox t)
    ${storage === "table" ? ",'groups',(select jsonb_agg(to_jsonb(t) order by role) from public.admin_role_defaults t)" : ""});`)
  const readGroups = async (reader = f.owner) => reader.one("select public.read_admin_permission_groups();")
  const write = (session, action, role, permissions, version) => session.one(`select public.write_admin_permission_group(${literal(action)},${literal(role)},${permissions === null ? "null" : literal(JSON.stringify(permissions))+"::jsonb"},${version === null ? "null" : literal(version)});`)
  const session = async (...args) => {
    const client = await f.session(...args), begin = client.begin.bind(client)
    client.begin = async (...values) => {
      await begin(...values)
      await client.query(`select set_config('request.headers',${literal(JSON.stringify({ "x-bunker-admin-user": "synthetic-operator", "x-bunker-admin-display-name": "Synthetic operator", "x-bunker-admin-page-id": "user-management" }))},true);`)
    }
    return client
  }
  return { ...f, session, storage, snapshot, readGroups, write, version: async role => (await readGroups()).groups.find(g => g.role === role)?.version ?? null }
}
