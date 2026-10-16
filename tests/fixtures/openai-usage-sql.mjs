import { readFileSync } from "node:fs"
export const usageSchema = readFileSync(new URL("../../supabase/migrations/20260723083832_add_openai_usage_events.sql", import.meta.url), "utf8")
export const usageMigration = readFileSync(new URL("../../supabase/migrations/20261016045316_complete_openai_usage_report.sql", import.meta.url), "utf8")
export const usageFixtureSql = `create role anon;create role authenticated;create role service_role bypassrls;
grant usage on schema public to service_role;${usageSchema}${usageMigration}`
export const usageScaleSql = `insert into public.openai_usage_events(occurred_at,page_id,page_path,feature,model,status,input_tokens,total_tokens,duration_ms)
select statement_timestamp()-interval '1 day'-i*interval '1 millisecond',
case when i=10001 then 'older' else 'recent' end,case when i=10001 then '/api/ecosystem/knowledge-extract' else '/admin' end,
'synthetic','test',case when i=10001 then 'error' else 'success' end,case when i=10001 then 1000000 else 1 end,
case when i=10001 then 1000000 else 1 end,10 from generate_series(1,10001) i;`
export async function setupUsageSql() {
  const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
  const db = new PGlite(); await db.exec(usageFixtureSql)
  return { db, report: async days => (await db.query("select public.get_openai_usage_report($1::integer) result", [days])).rows[0].result }
}
