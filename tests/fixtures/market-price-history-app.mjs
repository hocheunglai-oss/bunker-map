import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { transformSync } from "esbuild"
import * as history from "../../lib/marketPriceHistory.ts"
import * as publication from "../../lib/reportPublication.ts"
import * as adminPages from "../../lib/adminPages.ts"
import { setup, basis, linked, chained, other } from "./price-setter-sql.mjs"

// The real API and audit constructor execute the real migration in isolated
// PostgreSQL. Only session authorization and Supabase's HTTP adapter are fake.
export async function setupMarketHistoryApp() {
  const f = await setup(), calls = [], permissions = [], auditHeaders = []
  const migration = readFileSync(new URL("../../supabase/migrations/20261012114634_atomic_market_history_changes.sql", import.meta.url), "utf8")
  const publicationMigration = readFileSync(new URL("../../supabase/migrations/20261012114638_coherent_report_publication.sql", import.meta.url), "utf8")
  await f.db.exec(`update ports set hsfo_formula=null,vlsfo_formula=null,mgo_formula=null;
    update ports set name=case id when '${basis}' then 'Hong Kong' when '${linked}' then 'Kaohsiung' when '${chained}' then 'Taichung' else name end;
    insert into ports(name) values ('Keelung'),('Suao'),('Hualien');
    insert into remarks(id,content) values (1,'EXISTING REMARK'),(2,'EXISTING NOTICE');
    insert into price_history(port_id,hsfo,vlsfo,mgo,recorded_at) values
      ('${basis}',600,800,1000,'2026-10-01 23:30:00.000001'),('${basis}',500,700,900,'2026-09-30 23:30:00'),
      ('${basis}',100,200,300,'2026-10-01 20:00:00'),
      ('${linked}',600,800,1000,'2026-10-01 23:30:00.000001'),('${linked}',100,200,300,'2026-10-01 20:00:00'),
      ('${chained}',null,850,1050,'2026-10-01 22:00:00');
    ${migration}
    ${publicationMigration}`)
  const control = { access: "edit", auth: null, readFailure: false, badRead: false, badWrite: false, hold: null, release: null,
    publicationReadFailure: false, publicationBadRead: false, publicationBadWrite: false, beforePublication: null }
  const env = { NEXT_PUBLIC_SUPABASE_URL: "https://isolated.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-public" }
  const modules = {
    "node:crypto": { createHash },
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/marketPriceHistory": history,
    "@/lib/reportPublication": publication,
    "@/lib/adminPages": adminPages,
    "@/lib/adminAuth": { async requireAdminPagePermissionForRequest(_request, page, access) {
      permissions.push({ page, access })
      if (control.auth) throw Error(control.auth)
      if (access === "edit" && control.access !== "edit") throw Error("Forbidden")
      return { username: "SERVER-EDITOR", role: "BT" }
    } },
    "@supabase/supabase-js": { createClient(url, key, options) {
      assert.equal(url, env.NEXT_PUBLIC_SUPABASE_URL); assert.equal(key, env.SUPABASE_SERVICE_ROLE_KEY)
      auditHeaders.push(options.global.headers)
      return { async rpc(name, args) {
        calls.push({ name, args })
        if (control.hold === name) { control.hold = null; await new Promise(resolve => { control.release = resolve }) }
        try {
          if (name === "read_market_price_history") {
            if (control.readFailure) return { data: null, error: { message: "PRIVATE read failure" } }
            const result = await f.db.query("select public.read_market_price_history($1) as result", [args.p_market])
            return { data: control.badRead ? {} : result.rows[0].result, error: null }
          }
          if (name === "read_report_publication_source") {
            if (control.publicationReadFailure) return { data: null, error: { message: "PRIVATE publication read failure" } }
            const result = await f.db.query("select public.read_report_publication_source($1,$2::text[]) as result", [args.p_report, args.p_port_names])
            return { data: control.publicationBadRead ? {} : result.rows[0].result, error: null }
          }
          if (name === "publish_report_snapshot") {
            if (control.beforePublication) { const before = control.beforePublication; control.beforePublication = null; await before() }
            const result = await f.db.query("select public.publish_report_snapshot($1,$2::text[],$3::jsonb,$4::jsonb) as result",
              [args.p_report, args.p_port_names, JSON.stringify(args.p_expected_source), JSON.stringify(args.p_payload)])
            return { data: control.publicationBadWrite ? {} : result.rows[0].result, error: null }
          }
          assert.equal(name, "change_market_price_history")
          const result = await f.db.query("select public.change_market_price_history($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb) as result",
            [args.p_market,args.p_day,args.p_operation,JSON.stringify(args.p_expected_ports),JSON.stringify(args.p_expected_rows),JSON.stringify(args.p_values)])
          return { data: control.badWrite ? {} : result.rows[0].result, error: null }
        } catch (error) { return { data: null, error: { code: error.code, message: error.message } } }
      } }
    } },
  }
  function load(file) {
    const result = { exports: {} }
    const code = transformSync(readFileSync(new URL(file, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "process", code)(name => {
      assert.ok(Object.hasOwn(modules,name),name); return modules[name]
    }, result, result.exports, { env })
    return result.exports
  }
  modules["@/lib/adminAudit"] = load("../../lib/adminAudit.ts")
  const route = load("../../app/api/admin/price-history/route.ts")
  const publicationRoute = load("../../app/api/admin/report-publication/route.ts")
  await f.db.exec("set role service_role")
  return { ...f, calls, permissions, auditHeaders, control, route, publicationRoute, basis, linked, chained, other,
    async read(market="taiwan") {
      return route.GET(new Request(`http://localhost/api/admin/price-history?market=${market}`))
    },
  }
}
