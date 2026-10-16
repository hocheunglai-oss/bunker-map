import { readFileSync } from "node:fs"
import { spcStemFixtureSql } from "./spc-stem-sql.mjs"
import { supplierActor } from "./spc-supplier-api.mjs"

export function spcSupplierFixtureSql() {
  const source = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
  return `${spcStemFixtureSql()}
    ${source("supabase/office_calendar_store.sql")}
    grant select,insert,update,delete on public.office_calendar_store to service_role;
    create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.office_calendar_store
      for each statement execute function private.record_bunker_map_backup_mutation();
    update public.spc_users set username='${supplierActor.username}',display_name='${supplierActor.displayName}' where id='${supplierActor.userId}';
    ${source("supabase/migrations/20261016021125_atomic_spc_supplier_store.sql")}`
}
