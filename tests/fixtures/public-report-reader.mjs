import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { transformSync } from "esbuild"
import * as fallbackKeys from "../../lib/reportFallbackKeys.ts"
import * as operationalNotice from "../../lib/taiwanOperationalNotice.ts"
import * as validation from "../../lib/publicReportValidation.ts"

// Real public reader and route, same isolated database as the writer. The
// Next cache boundary is synthetic: HK/Taiwan deliberately bypass that cache.
export function publicReportReader(db) {
  const calls = [], control = { readFailure: false, rowsOverride: undefined }
  const modules = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "next/cache": { unstable_cache(fn) { return fn } },
    "@/lib/reportFallbackKeys": fallbackKeys,
    "@/lib/taiwanOperationalNotice": operationalNotice,
    "@/lib/publicReportValidation": validation,
    "@supabase/supabase-js": { createClient(url, key) {
      assert.equal(url, "https://isolated.invalid"); assert.equal(key, "synthetic-only")
      return { from(table) {
        assert.equal(table, "remarks")
        return { select(columns) {
          assert.equal(columns, "id,content")
          return { async in(column, ids) {
            assert.equal(column, "id"); calls.push({ table, ids })
            if (control.readFailure) return { data: null, error: Error("Synthetic public read failure") }
            if (control.rowsOverride !== undefined) return { data: control.rowsOverride, error: null }
            const result = await db.query("select id,content from public.remarks where id=any($1::integer[])", [ids])
            return { data: result.rows, error: null }
          } }
        } }
      } }
    } },
  }
  function load(file) {
    const result = { exports: {} }, code = transformSync(readFileSync(new URL(file, import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "process", code)(name => {
      assert.ok(Object.hasOwn(modules, name), name); return modules[name]
    }, result, result.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://isolated.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
    return result.exports
  }
  modules["@/lib/publicMarketData"] = load("../../lib/publicMarketData.ts")
  const route = load("../../app/api/reports/[key]/route.ts")
  return { route, calls, control }
}
