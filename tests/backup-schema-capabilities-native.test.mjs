import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { setupNativeCcinfo } from "./fixtures/native-postgres-ccinfo.mjs"
import { CREATION_MIGRATION, RECOVERY_MIGRATION, pricingBackupSchemaFromInventory, pricingBackupSchemaVersion } from "../lib/backupPricingSchema.mjs"

const migration = readFileSync(new URL("../supabase/migrations/20261012114540_explicit_backup_schema_capabilities.sql", import.meta.url), "utf8")
const extensionStart = migration.indexOf("  ) || pg_catalog.jsonb_build_object(")
assert.ok(extensionStart > 0)
// The migration retains the exact hosted catalog/fence body. Running that body
// before the extension independently proves its result is unchanged afterward.
const originalRpc = `${migration.slice(0, extensionStart)}  );\n$function$;`

test("native PostgreSQL inventory extension preserves the actual catalog SHA-256/fence contract and exact named hosted-version provenance", async () => {
  const db = await setupNativeCcinfo(`
    create role anon; create role authenticated; create role service_role;
    create schema private; create schema extensions; create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text);
    insert into supabase_migrations.schema_migrations values ('20260723101257',null),('20991231235959','unrelated_later_update');
    create function private.record_bunker_map_backup_mutation() returns trigger language plpgsql as $$ begin return null; end $$;
    -- This native runtime has no pgcrypto module installed. PostgreSQL's real
    -- SHA-256 primitive supplies the same byte algorithm, never a constant stub.
    create function extensions.digest(value bytea,algorithm text) returns bytea language sql immutable strict
      as $$ select case when algorithm='sha256' then pg_catalog.sha256(value) else null end $$;
    create table public.admin_sessions(id uuid);
    create table public.business_rows(id uuid primary key,note text not null default 'unchanged');
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.business_rows
      for each statement execute function private.record_bunker_map_backup_mutation();
    ${originalRpc}
  `)
  try {
    const inventory = () => db.owner.one("select public.get_bunker_map_backup_inventory();")
    const before = await inventory()
    const catalog = await db.owner.one(`select jsonb_build_object('text',coalesce(string_agg(jsonb_build_array(
      t.relname,t.relkind,c.attnum,c.attname,format_type(c.atttypid,c.atttypmod),c.attnotnull,c.attidentity,c.attgenerated,c.attcollation,
      coalesce(pg_get_expr(d.adbin,d.adrelid),''))::text,E'\n' order by t.relname,c.attnum),''))
      from pg_class t join pg_namespace n on n.oid=t.relnamespace join pg_attribute c on c.attrelid=t.oid
      left join pg_attrdef d on d.adrelid=t.oid and d.adnum=c.attnum
      where n.nspname='public' and t.relkind in ('r','p') and t.relpersistence='p' and c.attnum>0 and not c.attisdropped;`)
    assert.equal(before.catalogSha256, createHash("sha256").update(catalog.text, "utf8").digest("hex"))
    await db.owner.query(migration)
    let after = await inventory()
    for (const key of ["schema", "migrationHead", "tables", "unfencedTables", "catalogSha256"]) assert.deepEqual(after[key], before[key], key)
    assert.deepEqual(after.unfencedTables, [], "admin_sessions exemption and actual statement fence are unchanged")
    assert.equal(pricingBackupSchemaVersion(pricingBackupSchemaFromInventory(after)), "none")
    assert.deepEqual(after.appliedMigrations, [{ version: "20260723101257", name: null }, { version: "20991231235959", name: "unrelated_later_update" }])
    const privileges = await db.owner.one(`select jsonb_build_object(
      'public',exists(select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid='public.get_bunker_map_backup_inventory()'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'),
      'anon',has_function_privilege('anon','public.get_bunker_map_backup_inventory()','execute'),
      'authenticated',has_function_privilege('authenticated','public.get_bunker_map_backup_inventory()','execute'),
      'service',has_function_privilege('service_role','public.get_bunker_map_backup_inventory()','execute'));`)
    assert.deepEqual(privileges, { public: false, anon: false, authenticated: false, service: true })
    const service = await db.session("backup-inventory-service")
    assert.deepEqual(await service.one("select public.get_bunker_map_backup_inventory();"), after)
    await db.owner.query(`
      create table public.price_setter_creation_receipts(request_id uuid primary key,port_id uuid not null,kind text not null,created_at timestamptz not null);
      create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.price_setter_creation_receipts
        for each statement execute function private.record_bunker_map_backup_mutation();
      insert into supabase_migrations.schema_migrations values ('20980101000011','${CREATION_MIGRATION}');
    `)
    after = await inventory()
    assert.equal(pricingBackupSchemaVersion(pricingBackupSchemaFromInventory(after)), "creation-v1")
    assert.notEqual(after.catalogSha256, before.catalogSha256, "real catalog changes still change its digest")
    await db.owner.query(`insert into supabase_migrations.schema_migrations values ('20970101000022','${RECOVERY_MIGRATION}');`)
    after = await inventory()
    assert.throws(() => pricingBackupSchemaFromInventory(after), /columns/)
    await db.owner.query("alter table public.price_setter_creation_receipts add column actor_id uuid,add column acknowledged_at timestamptz;")
    after = await inventory()
    const proven = pricingBackupSchemaFromInventory(after)
    assert.equal(pricingBackupSchemaVersion(proven), "recovery-v2")
    assert.deepEqual(proven.appliedMigrations, [
      { version: "20970101000022", name: RECOVERY_MIGRATION },
      { version: "20980101000011", name: CREATION_MIGRATION },
    ], "hosted versions are retained verbatim, while stable names decide capability")
    await db.owner.query("drop table public.price_setter_creation_receipts;")
    after = await inventory()
    assert.throws(() => pricingBackupSchemaFromInventory(after), /table/)
  } finally { await db.close() }
})
