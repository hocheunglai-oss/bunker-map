import { readFileSync } from "node:fs"
import { priceSetterSnapshot, buildPriceSetterChanges } from "../../lib/priceSetterMutation.ts"

// Mandatory isolated PostgreSQL execution; no live data or quiet skips.
const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const migration = readFileSync(new URL("../../supabase/migrations/20261008112629_atomic_price_setter_save.sql", import.meta.url), "utf8")
const deletionMigration = readFileSync(new URL("../../supabase/migrations/20261009044514_protect_price_setter_port_deletion.sql", import.meta.url), "utf8")
const identityMigration = readFileSync(new URL("../../supabase/migrations/20261009045645_protect_required_report_port_identity.sql", import.meta.url), "utf8")
const creationMigration = readFileSync(new URL("../../supabase/migrations/20261009050520_idempotent_price_setter_port_creation.sql", import.meta.url), "utf8")
const inventoryMigration = readFileSync(new URL("../../supabase/migrations/20261009051842_complete_price_setter_inventory.sql", import.meta.url), "utf8")
const creationRecoveryMigration = readFileSync(new URL("../../supabase/migrations/20261009054830_durable_price_setter_creation_recovery.sql", import.meta.url), "utf8")
const creationCutoverMigration = readFileSync(new URL("../../supabase/migrations/20261009070459_fence_legacy_price_setter_creation.sql", import.meta.url), "utf8")
const dividerLockMigration = readFileSync(new URL("../../supabase/migrations/20261009110700_order_divider_rename_locks.sql", import.meta.url), "utf8")
// Execute the actual backup mutation/fence functions, without the later
// project-wide inventory/catalog RPC (which needs the complete hosted schema).
const epochFunctions = readFileSync(new URL("../../supabase/migrations/20260723101257_add_backup_export_epoch.sql", import.meta.url), "utf8").split("do $$")[0]
export const basis = "11111111-1111-4111-8111-111111111111", linked = "22222222-2222-4222-8222-222222222222", chained = "33333333-3333-4333-8333-333333333333", other = "44444444-4444-4444-8444-444444444444"

export async function setup({ creationRecovery = false, creationCutover = false } = {}) {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.ports(id uuid primary key default gen_random_uuid(), name text not null, lat numeric, lng numeric, hsfo numeric, vlsfo numeric, mgo numeric, hsfo_formula text, vlsfo_formula text, mgo_formula text, updated_at date, display_order integer, type text default 'port');
    create table public.price_history(id uuid primary key default gen_random_uuid(), port_id uuid references public.ports(id) on delete cascade, hsfo numeric, vlsfo numeric, mgo numeric, recorded_at timestamp without time zone default now());
    create table public.remarks(id integer primary key,content text);
    grant select, insert, update, delete on public.ports, public.price_history, public.remarks to service_role;
    insert into public.ports(id,name,lat,lng,hsfo,vlsfo,mgo,updated_at) values ('${basis}','Basis',0,0,600,800,1000,'2026-10-08'),('${linked}','Linked',null,null,null,null,null,'2026-10-08'),('${chained}','Chained',null,null,null,null,null,'2026-10-08'),('${other}','Other',null,null,100,200,300,'2026-10-08');
    update public.ports set vlsfo_formula='Basis + 0',mgo_formula='Basis - -5' where id='${linked}';
    update public.ports set vlsfo_formula='Linked + 10' where id='${chained}';
    ${migration}
    ${deletionMigration}
    ${identityMigration}
    ${epochFunctions}
    ${creationMigration}
    ${inventoryMigration}
    ${creationRecovery || creationCutover ? creationRecoveryMigration : ""}
    ${creationCutover ? creationCutoverMigration : ""}
    ${dividerLockMigration}
  `)
  async function row(id = basis) {
    return (await db.query("select to_jsonb(p) as port from public.ports p where id=$1::uuid", [id])).rows[0].port
  }
  async function save(changes = {}, options = {}) {
    const saved = await row(options.id || basis)
    return (await db.query("select public.save_price_setter_port($1::uuid,$2::jsonb,$3::jsonb,$4::timestamptz) as result", [options.id || basis, JSON.stringify(options.expected || priceSetterSnapshot(saved)), JSON.stringify(buildPriceSetterChanges({ ...saved, ...changes })), options.time || "2026-10-08T18:30:00.123Z"])).rows[0].result
  }
  async function state() {
    return (await db.query("select (select jsonb_agg(to_jsonb(p) order by id) from ports p) as ports,(select jsonb_agg(to_jsonb(h) order by id) from price_history h) as history")).rows[0]
  }
  return { db, row, save, state }
}
