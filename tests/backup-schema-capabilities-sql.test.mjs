import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { CREATION_MIGRATION, RECOVERY_MIGRATION, pricingBackupSchemaFromInventory, pricingBackupSchemaVersion } from "../lib/backupPricingSchema.mjs"

const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
const migration = readFileSync(new URL("../supabase/migrations/20261012114540_explicit_backup_schema_capabilities.sql", import.meta.url), "utf8")

test("actual inventory SQL supplies exact sparse history and physical schema, preserves privilege/fence boundaries, and reveals missing installed state", async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema private; create schema extensions; create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key,name text);
      insert into supabase_migrations.schema_migrations values ('20260723101257',null),('20991231235959','unrelated_later_update');
      create function private.record_bunker_map_backup_mutation() returns trigger language plpgsql as $$ begin return null; end $$;
      -- The catalog digest itself is unchanged; this narrow fixture only supplies
      -- the existing extension signature, while exercising the real catalog SQL.
      create function extensions.digest(bytea,text) returns bytea language sql as $$ select pg_catalog.decode(repeat('ab',32),'hex') $$;
      create table public.admin_sessions(id uuid);
      ${migration}
    `)
    const inventory = async () => (await db.query("select public.get_bunker_map_backup_inventory() as result")).rows[0].result
    let value = await inventory()
    assert.equal(value.migrationHead, "20991231235959")
    assert.deepEqual(value.appliedMigrations, [{ version: "20260723101257", name: null }, { version: "20991231235959", name: "unrelated_later_update" }])
    assert.deepEqual(value.receiptColumns, [])
    assert.equal(pricingBackupSchemaVersion(pricingBackupSchemaFromInventory(value)), "none")
    assert.equal(value.unfencedTables.includes("admin_sessions"), false, "retain the actual hosted RPC's existing exemption")
    for (const role of ["anon", "authenticated"]) assert.equal((await db.query(`select has_function_privilege('${role}','public.get_bunker_map_backup_inventory()','execute') as allowed`)).rows[0].allowed, false)
    assert.equal((await db.query("select has_function_privilege('service_role','public.get_bunker_map_backup_inventory()','execute') as allowed")).rows[0].allowed, true)
    const security = (await db.query("select prosecdef,provolatile,proconfig from pg_proc where oid='public.get_bunker_map_backup_inventory()'::regprocedure")).rows[0]
    assert.equal(security.prosecdef, true)
    assert.equal(security.provolatile, "s")
    assert.deepEqual(security.proconfig, ["search_path=pg_catalog, pg_temp"])

    await db.exec(`create table public.price_setter_creation_receipts(request_id uuid primary key,port_id uuid not null,kind text not null,created_at timestamptz not null); insert into supabase_migrations.schema_migrations values ('20980101000001','${CREATION_MIGRATION}');`)
    value = await inventory()
    assert.equal(pricingBackupSchemaVersion(pricingBackupSchemaFromInventory(value)), "creation-v1")
    assert.equal(value.unfencedTables.includes("price_setter_creation_receipts"), true, "the receipt table is never reclassified as ephemeral")
    await db.exec("create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.price_setter_creation_receipts for each statement execute function private.record_bunker_map_backup_mutation();")
    assert.equal((await inventory()).unfencedTables.includes("price_setter_creation_receipts"), false)

    await db.exec(`insert into supabase_migrations.schema_migrations values ('20980101000002','${RECOVERY_MIGRATION}');`)
    value = await inventory()
    assert.throws(() => pricingBackupSchemaFromInventory(value), /columns/, "a later recovery migration receipt cannot conceal missing physical columns")
    await db.exec("alter table public.price_setter_creation_receipts add column actor_id uuid, add column acknowledged_at timestamptz;")
    value = await inventory()
    assert.equal(pricingBackupSchemaVersion(pricingBackupSchemaFromInventory(value)), "recovery-v2")
    await db.exec("alter table public.price_setter_creation_receipts drop column acknowledged_at;")
    value = await inventory()
    assert.throws(() => pricingBackupSchemaFromInventory(value), /columns/)
    await db.exec("drop table public.price_setter_creation_receipts;")
    value = await inventory()
    assert.throws(() => pricingBackupSchemaFromInventory(value), /table/, "unexpected table loss is different from never-applied pricing migrations")
  } finally { await db.close() }
})
