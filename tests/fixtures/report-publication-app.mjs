import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { transformSync } from "esbuild"
import * as publication from "../../lib/reportPublication.ts"
import * as adminPages from "../../lib/adminPages.ts"
import * as mutation from "../../lib/priceSetterMutation.ts"
import * as priceHistory from "../../lib/priceHistoryRecords.ts"
import * as settings from "../../lib/priceSetterSettings.ts"
import * as order from "../../lib/priceSetterOrder.ts"
import * as inventory from "../../lib/priceSetterInventory.ts"
import * as creationRecovery from "../../lib/priceSetterCreationRecovery.ts"
import * as priceRequest from "../../lib/priceSetterRequest.ts"
import { setup, basis, linked, chained, other } from "./price-setter-sql.mjs"

const migration = readFileSync(new URL("../../supabase/migrations/20261009032431_coherent_report_publication.sql", import.meta.url), "utf8")
const recoveryMigration = readFileSync(new URL("../../supabase/migrations/20261009043924_recover_damaged_report_publications.sql", import.meta.url), "utf8")
export async function setupReportPublicationApp() {
  const f = await setup({ creationCutover: true }), calls = [], permissions = [], auditHeaders = []
  await f.db.exec(`update ports set hsfo_formula=null,vlsfo_formula=null,mgo_formula=null;
    update ports set name=case id when '${basis}' then 'Hong Kong' when '${linked}' then 'Kaohsiung' when '${chained}' then 'Taichung' else 'Dalian' end;
    insert into ports(name,vlsfo_formula,mgo_formula,updated_at) values ('Keelung','Taichung + 0','Taichung + 0','2026-10-08'),('Suao',null,null,'2026-10-08'),('Hualien',null,null,'2026-10-08');
    insert into price_history(port_id,recorded_at,hsfo,vlsfo,mgo) select id,'2026-10-08T23:30:00.000002',hsfo,vlsfo,mgo from ports where id in ('${basis}','${linked}','${chained}');
    insert into price_history(port_id,recorded_at,hsfo,vlsfo,mgo) select id,'2026-10-07T23:30:00.000001',500,700,900 from ports where id in ('${basis}','${linked}','${chained}');
    insert into remarks(id,content) values (1,'Remark\nSecond line'),(2,'Special notice\nSecond line');
    ${migration}
    ${recoveryMigration}`)
  const control = { access: "edit", auth: null, actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", readFailure: false, badRead: false, badWrite: false, beforeWrite: null }
  const env = { NEXT_PUBLIC_SUPABASE_URL: "https://isolated.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-public" }
  const modules = {
    "node:crypto": { createHash },
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/reportPublication": publication,
    "@/lib/adminPages": adminPages,
    "@/lib/priceSetterMutation": mutation,
    "@/lib/priceHistoryRecords": priceHistory,
    "@/lib/priceSetterSettings": settings,
    "@/lib/priceSetterOrder": order,
    "@/lib/priceSetterInventory": inventory,
    "@/lib/priceSetterCreationRecovery": creationRecovery,
    "@/lib/priceSetterRequest": priceRequest,
    "@/lib/adminAuth": { async requireAdminPagePermissionForRequest(_request, page, access) {
      permissions.push({ page, access })
      if (control.auth) throw Error(control.auth)
      if (access === "edit" && control.access !== "edit") throw Error("Forbidden")
      return { username: "SERVER-EDITOR", role: "BT", adminUserId: control.actorId }
    } },
    "@supabase/supabase-js": { createClient(url, key, options) {
      assert.equal(url, env.NEXT_PUBLIC_SUPABASE_URL); assert.equal(key, env.SUPABASE_SERVICE_ROLE_KEY)
      auditHeaders.push(options.global.headers)
      return { async rpc(name, args) {
        calls.push({ name, args })
        try {
          if (name === "read_price_setter_inventory") {
            if (control.readFailure) return { data: null, error: { message: "PRIVATE read failure" } }
            const result = await f.db.query("select public.read_price_setter_inventory() as result")
            return { data: control.badRead ? {} : result.rows[0].result, error: null }
          }
          if (name === "reorder_price_setter_ports") {
            const result = await f.db.query("select public.reorder_price_setter_ports($1::jsonb,$2::uuid[]) as result", [JSON.stringify(args.p_expected), args.p_order])
            return { data: control.badWrite ? {} : result.rows[0].result, error: null }
          }
          if (name === "read_report_publication_source") {
            if (control.readFailure) return { data: null, error: { message: "PRIVATE read failure" } }
            const result = await f.db.query("select public.read_report_publication_source($1,$2::text[]) as result", [args.p_report, args.p_port_names])
            return { data: control.badRead ? {} : result.rows[0].result, error: null }
          }
          if (name === "read_price_setter_creation_state") {
            if (control.readFailure) return { data: null, error: { message: "PRIVATE read failure" } }
            const result = await f.db.query("select public.read_price_setter_creation_state($1::uuid) as result", [args.p_actor_id])
            return { data: control.badRead ? {} : result.rows[0].result, error: null }
          }
          if (name === "acknowledge_price_setter_creation") {
            const result = await f.db.query("select public.acknowledge_price_setter_creation($1::uuid,$2::uuid) as result", [args.p_actor_id, args.p_request_id])
            return { data: control.badWrite ? {} : result.rows[0].result, error: null }
          }
          if (name === "create_owned_price_setter_port") {
            const result = await f.db.query("select public.create_owned_price_setter_port($1::uuid,$2::uuid,$3::text,$4::bigint) as result", [args.p_actor_id, args.p_request_id, args.p_kind, args.p_expected_version])
            return { data: control.badWrite ? {} : result.rows[0].result, error: null }
          }
          if (name === "save_price_setter_port") {
            const result = await f.db.query("select public.save_price_setter_port($1::uuid,$2::jsonb,$3::jsonb,$4::timestamptz) as result",
              [args.p_port_id, JSON.stringify(args.p_expected), JSON.stringify(args.p_changes), args.p_recorded_at])
            return { data: result.rows[0].result, error: null }
          }
          if (name === "delete_price_setter_port") {
            if (control.beforeWrite) { const before = control.beforeWrite; control.beforeWrite = null; await before() }
            const result = await f.db.query("select public.delete_price_setter_port($1::uuid,$2::jsonb,$3::jsonb) as result",
              [args.p_port_id, JSON.stringify(args.p_expected), JSON.stringify(args.p_expected_fallbacks)])
            return { data: control.badWrite ? {} : result.rows[0].result, error: null }
          }
          assert.equal(name, "publish_report_snapshot")
          if (control.beforeWrite) { const before = control.beforeWrite; control.beforeWrite = null; await before() }
          const result = await f.db.query("select public.publish_report_snapshot($1,$2::text[],$3::jsonb,$4::jsonb) as result",
            [args.p_report, args.p_port_names, JSON.stringify(args.p_expected_source), JSON.stringify(args.p_payload)])
          return { data: control.badWrite ? {} : result.rows[0].result, error: null }
        } catch (error) { return { data: null, error: { code: error.code, message: error.message } } }
      } }
    } },
  }
  function load(file) {
    const result = { exports: {} }, code = transformSync(readFileSync(new URL(file, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    class ServerClock extends Date { constructor(...args) { super(...(args.length ? args : ["2026-10-09T03:00:00.123Z"])) } }
    new Function("require", "module", "exports", "process", "Date", code)(name => {
      assert.ok(Object.hasOwn(modules, name), name); return modules[name]
    }, result, result.exports, { env }, ServerClock)
    return result.exports
  }
  modules["@/lib/adminAudit"] = load("../../lib/adminAudit.ts")
  const route = load("../../app/api/admin/report-publication/route.ts")
  const priceRoute = load("../../app/api/admin/prices/route.ts")
  const creationRoute = load("../../app/api/admin/prices/creation/route.ts")
  await f.db.exec("set role service_role")
  return { ...f, calls, permissions, auditHeaders, control, route, priceRoute, creationRoute, basis, linked, chained, other,
    async read(report = "taiwan", page = publication.REPORT_PUBLICATIONS[report].page) {
      return route.GET(new Request(`http://localhost/api/admin/report-publication?report=${report}&page=${page}`, { headers: { referer: "https://evil.invalid/admin/users" } }))
    },
    async publish(input, report = "taiwan", page = publication.REPORT_PUBLICATIONS[report].page) {
      return route.POST(new Request(`http://localhost/api/admin/report-publication?report=${report}&page=${page}`, {
        method: "POST", headers: { "content-type": "application/json", referer: "https://evil.invalid/admin/users" }, body: JSON.stringify(input),
      }))
    },
    async input(report = "taiwan", dateOverride = "") {
      const response = await this.read(report), data = await response.json()
      assert.equal(response.status, 200, JSON.stringify(data))
      return { sourceVersion: data.sourceVersion, publicationVersion: data.publicationVersion, dateOverride }
    },
    async publications() { return (await f.db.query("select id,content from remarks where id in (101,102,103,104) order by id")).rows },
  }
}
