import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"
import { createClient } from "@supabase/supabase-js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), require = createRequire(import.meta.url)
const clock = "2026-10-16T04:00:00.000Z"
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])) }
  static now() { return Date.parse(clock) }
}

// Only the actor and network response are synthetic. The routes, SDK RPC/body
// decoding, source validation, metadata, identity and wire decoder are real.
export function createRecordPageRoute({ kind = "lost", enquiries = [], fixtures = [], role = "SUPPLIER TRADER", permission = "view", authenticated = true, queryError = null, rpcSource, fetchResponse } = {}) {
  const queries = [], contexts = [], cache = new Map(), pageId = kind === "lost" ? "spc-lost-record" : "spc-today-enquiries"
  const mocks = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/spcLostReasons": { updateSpcLostRecordReview() { throw Error("No writes in read fixture") } },
    "@/lib/spcAudit": {
      createSpcAuditContext(...args) { contexts.push(args); return { synthetic: true } },
      createSpcAuditedSupabaseClient() {
        return createClient("https://synthetic.invalid", "synthetic-no-credential", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: async (url, init) => {
            const name = new URL(url).pathname.split("/").at(-1)
            assert.equal(name, kind === "lost" ? "read_spc_lost_record_page" : "read_spc_today_enquiry_page")
            assert.equal(init.method, "POST")
            const args = JSON.parse(init.body); queries.push({ name, ...args, signal: init.signal })
            if (fetchResponse) return fetchResponse({ name, args, init })
            if (queryError) return Response.json({ code: queryError.code || "08006", message: queryError.message }, { status: 503 })
            if (rpcSource) return Response.json(await rpcSource({ name, ...args }))
            const day = kind === "today" ? "2026-10-16" : null
            const all = enquiries.filter(row => kind === "lost" ? row.status === "cancelled" : Date.parse(row.created_at) >= Date.parse(`${day}T00:00:00+08:00`) && Date.parse(row.created_at) < Date.parse("2026-10-17T00:00:00+08:00"))
              .sort((a, b) => { const at = Date.parse(a.created_at) - Date.parse(b.created_at); return at ? at * (kind === "lost" ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0 })
            const mainRevision = createHash("sha256").update(JSON.stringify(all)).digest("hex"), cursor = args.p_cursor, size = args.p_page_size
            const boundary = cursor ? all.findIndex(row => row.id === cursor.id && Date.parse(row.created_at) === Date.parse(cursor.createdAt)) : -1
            if (cursor && (cursor.revision !== mainRevision || cursor.day !== day || boundary < 0 || (boundary + 1) % size)) return Response.json({ code: "40001", message: "Refresh required" }, { status: 409 })
            const start = boundary + 1, rows = all.slice(start, start + size), last = rows.at(-1)
            const sourceFixtures = kind === "today" ? fixtures.filter(row => row.fixture_status === "completed") : []
            const lost = kind === "today" ? enquiries.filter(row => row.status === "cancelled").map(({ id, vessel_name, notes, created_at, updated_at }) => ({ id, vessel_name, notes, created_at, updated_at })) : []
            return Response.json({ schema: "spc.record-page-source/v1", kind, day, checkedAt: clock, pageSize: size, totalCount: all.length, pageCount: Math.ceil(all.length / size), pageIndex: all.length ? start / size + 1 : 0,
              mainRevision, nextCursor: start + rows.length < all.length ? { kind, day, createdAt: last.created_at, id: last.id, revision: mainRevision } : null,
              rows, fixtures: sourceFixtures, lost, sourceCounts: { rows: rows.length, fixtures: sourceFixtures.length, lost: lost.length } })
          } },
        })
      },
    },
  }
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!name.startsWith("@/") && !name.startsWith(".")) return require(name)
    const unresolved = name.startsWith("@/") ? join(root, name.slice(2)) : resolve(parent, name)
    const file = ["", ".ts", ".json", ".js"].map(ext => unresolved + ext).find(existsSync)
    assert.ok(file, "Unresolved " + name)
    if (file.endsWith(".json")) return JSON.parse(readFileSync(file, "utf8"))
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }; cache.set(file, mod)
    const code = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
    new Function("require", "module", "exports", "Date", code)(request => load(request, dirname(file)), mod, mod.exports, FixedDate)
    return mod.exports
  }
  const pages = load("@/lib/spcPages")
  const session = { authenticated, username: "synthetic@example.test", role, permissions: pages.normaliseSpcPagePermissions({ [pageId]: pages.constrainSpcPermissionForRole(role, pageId, permission) }) }
  mocks["@/lib/spcAuth"] = { async requireSpcPagePermission(page, access) { assert.equal(page, pageId); if (!session.authenticated) throw new Error("Unauthorized"); if (!pages.canAccessSpcPage(session.permissions, page, access)) throw new Error("Forbidden"); return session } }
  return { queries, contexts, load, identity: load("@/lib/spcVesselIdentity"), async get({ cursor, pageSize, signal, rawQuery } = {}) {
    const params = new URLSearchParams()
    if (cursor) params.set("cursor", JSON.stringify(cursor))
    if (pageSize !== undefined) params.set("pageSize", String(pageSize))
    const response = await load(`@/app/api/spc/${kind === "lost" ? "lost-record" : "today-enquiries"}/route`).GET(new Request(`https://synthetic.invalid/api/spc/${kind}?${rawQuery ?? params}`, { signal }))
    return { status: response.status, body: await response.json(), cache: response.headers.get("Cache-Control") }
  } }
}
