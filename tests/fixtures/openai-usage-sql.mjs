import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
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
  if (process.env.NATIVE_PG_BIN) {
    const { setupNativeCcinfo, literal } = await import("./native-postgres-ccinfo.mjs")
    const fixture = await setupNativeCcinfo(usageFixtureSql)
    let sequence = 0
    // Ordinary reports use real service-role backends. An expected SQL error
    // ends that psql backend (ON_ERROR_STOP), not the owner used for setup and
    // metadata. Never catch/rewrite a database error or emulate a transaction.
    const context = () => fixture.owner.one(`select jsonb_build_object(
      'pid',pg_backend_pid(),'role',current_user,
      'readOnly',current_setting('transaction_read_only'));
    `)
    const report = async days => {
      const current = await context()
      assert.equal(current.pid, fixture.owner.pid)
      const statement = `select public.get_openai_usage_report(${days === null ? "null" : literal(days)}::integer);`
      if (current.readOnly === "on") {
        // The existing test's BEGIN READ ONLY / SET LOCAL ROLE must apply to
        // this exact backend, not a fresh autocommit connection. Its settings
        // are read from PostgreSQL itself, not inferred from a SQL string.
        assert.equal(current.role, "service_role", "Explicit read-only report must retain SET LOCAL ROLE")
        return fixture.owner.one(statement)
      }
      assert.equal(current.readOnly, "off")
      assert.equal(current.role, "fcuno_ccinfo_fixture_owner")
      const reader = await fixture.session(`usage-sql-report-${++sequence}`)
      try { return await reader.one(statement) } finally { await reader.close() }
    }
    return {
      db: {
        exec: statement => fixture.owner.query(statement.trimEnd().endsWith(";") ? statement : statement + ";"),
        async query(statement, parameters = []) {
          assert.deepEqual(parameters, [], "Metadata fixture queries do not accept substituted SQL parameters")
          assert.match(statement, /^\s*select\b/i)
          const rows = await fixture.owner.one(`select coalesce(jsonb_agg(to_jsonb(result)),'[]'::jsonb)
            from (${statement.trim().replace(/;$/, "")}) result;`)
          return { rows }
        },
        close: () => fixture.close(),
      },
      report,
    }
  }
  const { PGlite } = await import(process.env.PGLITE_MODULE_PATH || "@electric-sql/pglite")
  const db = new PGlite(); await db.exec(usageFixtureSql)
  return { db, report: async days => (await db.query("select public.get_openai_usage_report($1::integer) result", [days])).rows[0].result }
}
