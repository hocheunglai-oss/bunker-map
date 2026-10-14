/* Actual page + guard -> actual route + attendanceData -> isolated PostgreSQL
 * tables -> actual GET -> UI. Auth and transport are explicitly synthetic.
 * Run with NODE_PATH providing Playwright/esbuild and PGLITE_MODULE_PATH.
 * Does not load .env, connect to hosted services, send mail, or run sync jobs.
 * Foundation table constraints are real; RLS/audit/invalidation triggers and
 * live session resolution are deliberately outside this local fixture.
 */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { readFileSync } = require("node:fs")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")
const { pathToFileURL } = require("node:url")

const root = path.resolve(__dirname, "..")
const ownId = "11111111-1111-4111-8111-111111111111"
const otherId = "22222222-2222-4222-8222-222222222222"
const ownAdmin = "33333333-3333-4333-8333-333333333333"
const otherAdmin = "44444444-4444-4444-8444-444444444444"
const identifier = (value) => {
  assert.match(value, /^[a-z_][a-z0-9_]*$/)
  return `"${value}"`
}
const jsonRows = (rows) => JSON.parse(JSON.stringify(rows))

function tableDefinition(filename, table) {
  const text = readFileSync(path.join(root, "supabase/migrations", filename), "utf8")
  const match = text.match(new RegExp(`create table (?:if not exists )?public\\.${table} \\([\\s\\S]+?\\n\\);`, "i"))
  assert.ok(match, `Missing real DDL for ${table}`)
  return match[0]
}

async function backend() {
  if (!process.env.PGLITE_MODULE_PATH) throw new Error("PGLITE_MODULE_PATH is required; never substitute a hosted database")
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href)
  const db = new PGlite()
  const now = new Date(Date.now() + 8 * 3600 * 1000)
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth() + 1
  const closedYear = currentYear - 1
  const foundation = "20260807091428_create_attendance_record_foundation.sql"
  const roster = "20260810034059_attendance_monthly_roster_and_reminders.sql"
  const workModes = "20260810082031_attendance_work_modes_and_calendar.sql"
  await db.exec("set timezone='UTC'; create table public.admin_users (id uuid primary key);")
  for (const table of ["attendance_people", "attendance_raw_punches", "attendance_leave_entries", "attendance_manual_overrides",
    "attendance_entitlements", "attendance_monthly_adjustments", "attendance_monthly_confirmations", "attendance_sync_runs"]) {
    await db.exec(tableDefinition(foundation, table))
  }
  await db.exec(`alter table public.attendance_people add column admin_user_id uuid references public.admin_users(id) on delete restrict;
    alter table public.attendance_people add column roster_order integer not null default 1000;
    create unique index attendance_people_admin_user_id_key on public.attendance_people(admin_user_id) where admin_user_id is not null;`)
  for (const table of ["attendance_team_assignments", "attendance_reminder_dispatches"]) await db.exec(tableDefinition(roster, table))
  for (const table of ["attendance_work_mode_policies", "attendance_work_mode_overrides"]) await db.exec(tableDefinition(workModes, table))
  await db.exec("create table public.office_calendar_store (key text primary key, payload jsonb);")
  await db.query("insert into public.admin_users(id) values ($1),($2)", [ownAdmin, otherAdmin])
  await db.query(`insert into public.attendance_people(id,staff_code,display_name,team,admin_user_id,roster_order)
    values ($1,'AT','Alice Test','BT',$2,1),($3,'BT','Bob Test','BT',$4,2)`, [ownId, ownAdmin, otherId, otherAdmin])
  await db.query("insert into public.office_calendar_store(key,payload) values ('event-calendar',$1)", [JSON.stringify({ events: [], people: ["AT", "BT"] })])

  const allowed = new Set(["attendance_people", "attendance_raw_punches", "attendance_leave_entries", "attendance_manual_overrides",
    "attendance_entitlements", "attendance_monthly_adjustments", "attendance_monthly_confirmations", "attendance_sync_runs",
    "attendance_team_assignments", "attendance_reminder_dispatches", "attendance_work_mode_policies", "attendance_work_mode_overrides", "office_calendar_store"])
  const trace = []
  let failNext = false
  let holdNext = false
  let release = null
  const client = {
    from(table) {
      assert.ok(allowed.has(table), `Unexpected table: ${table}`)
      const predicates = []
      const params = []
      const orders = []
      let columns = "*"
      let values
      let conflict
      let range
      let mode
      const filter = (column, operator, value) => {
        params.push(value)
        predicates.push(`${identifier(column)} ${operator} $${params.length}`)
        return query
      }
      const query = {
        select(value = "*") { columns = value === "*" ? "*" : value.split(",").map(identifier).join(","); return query },
        eq(column, value) { return filter(column, "=", value) },
        gte(column, value) { return filter(column, ">=", value) },
        lte(column, value) { return filter(column, "<=", value) },
        order(column, options = {}) { orders.push(`${identifier(column)} ${options.ascending === false ? "desc" : "asc"}`); return query },
        range(from, to) { range = [from, to]; return query },
        or(value) {
          const match = value.match(/^effective_to\.is\.null,effective_to\.gte\.(\d{4}-\d{2}-\d{2})$/)
          assert.ok(match, `Unexpected OR: ${value}`)
          params.push(match[1]); predicates.push(`(effective_to is null or effective_to >= $${params.length})`)
          return query
        },
        upsert(input, options) {
          assert.equal(table, "attendance_monthly_confirmations", "fixture allows only confirmation writes")
          assert.deepEqual(options, { onConflict: "person_id,year,month" })
          values = input; conflict = options.onConflict; return query
        },
        single() { mode = "single"; return execute() },
        maybeSingle() { mode = "maybe"; return execute() },
        then(resolve, reject) { return execute().then(resolve, reject) },
      }
      async function execute() {
        try {
          let result
          if (values) {
            trace.push({ operation: "upsert", table, values: { ...values } })
            if (holdNext) { holdNext = false; await new Promise((resolve) => { release = resolve }); release = null }
            if (failNext) { failNext = false; return { data: null, error: { message: "Synthetic storage outage" } } }
            const keys = Object.keys(values)
            result = await db.query(`insert into public.${identifier(table)} (${keys.map(identifier).join(",")})
              values (${keys.map((_, index) => `$${index + 1}`).join(",")})
              on conflict (${conflict.split(",").map(identifier).join(",")}) do update set
              ${keys.map((key) => `${identifier(key)}=excluded.${identifier(key)}`).join(",")} returning ${columns}`, keys.map((key) => values[key]))
          } else {
            let sql = `select ${columns} from public.${identifier(table)}`
            if (predicates.length) sql += ` where ${predicates.join(" and ")}`
            if (orders.length) sql += ` order by ${orders.join(",")}`
            if (range) {
              assert.ok(range.every(Number.isSafeInteger))
              sql += ` limit ${range[1] - range[0] + 1} offset ${range[0]}`
            }
            result = await db.query(sql, params)
            trace.push({ operation: "select", table, rows: result.rows.length })
          }
          const rows = jsonRows(result.rows)
          if (mode === "single" && rows.length !== 1) return { data: null, error: { message: "Expected exactly one row" } }
          if (mode === "maybe" && rows.length > 1) return { data: null, error: { message: "Expected at most one row" } }
          return { data: mode ? rows[0] ?? null : rows, error: null }
        } catch (error) { return { data: null, error: { message: error.message, code: error.code } } }
      }
      return query
    },
    async rpc(name, args) {
      if (name === "attendance_source_revision") return { data: 0, error: null }
      if (name === "save_attendance_monthly_confirmation_checked") {
        try {
          assert.equal(args.p_expected_revision, 0)
          trace.push({ operation: "confirmation-rpc", table: "attendance_monthly_confirmations", args })
          if (holdNext) { holdNext = false; await new Promise((resolve) => { release = resolve }); release = null }
          if (failNext) { failNext = false; return { data: null, error: { message: "Synthetic storage outage" } } }
          const result = await db.query(`insert into public.attendance_monthly_confirmations
            (person_id,year,month,status,confirmed_at,confirmed_by,note,created_by,updated_by)
            values ($1,$2,$3,$4,case when $4='confirmed' then now() else null end,
              case when $4='confirmed' then $5 else null end,$6,$5,$5)
            on conflict (person_id,year,month) do update set
              status=excluded.status,confirmed_at=excluded.confirmed_at,
              confirmed_by=excluded.confirmed_by,note=excluded.note,updated_by=excluded.updated_by
            returning *`, [args.p_person_id, args.p_year, args.p_month, args.p_status, args.p_actor, args.p_note])
          return { data: jsonRows(result.rows), error: null }
        } catch (error) { return { data: null, error: { message: error.message, code: error.code } } }
      }
      assert.equal(name, "list_attendance_available_years")
      return { data: [{ year: currentYear }, { year: closedYear }], error: null }
    },
  }
  const auth = {
    async requireAdminPagePermissionForRequest(request, page, level) {
      assert.equal(page, "attendance-record"); assert.equal(level, "view")
      const permission = request.headers.get("x-test-permission") || "view"
      if (permission === "none") throw new Error("Forbidden")
      return { adminUserId: ownAdmin, username: "alice@example.invalid", displayName: "Alice Test", fixturePermission: permission }
    },
    hasAdminPagePermission(session, page, level) {
      assert.equal(page, "attendance-record"); assert.equal(level, "edit")
      return session.fixturePermission === "edit"
    },
  }
  const boundaries = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "server-only": {},
    "@supabase/supabase-js": { createClient(url, key) {
      assert.equal(url, "https://attendance-fixture.invalid"); assert.equal(key, "synthetic-service-key")
      return client
    } },
    "@/lib/adminAuth": auth,
    "@/lib/adminAudit": {
      createAdminAuditContext(session) { return { session } },
      createAdminAuditedSupabaseClient(_context, options) { assert.deepEqual(options, { useServiceRole: true }); return client },
    },
    "@/lib/adminUsers": { async listManagedAdminUsers() { return [
      { id: ownAdmin, username: "alice@example.invalid", displayName: "Alice Test", isActive: true, attendanceGroup: "BT" },
      { id: otherAdmin, username: "bob@example.invalid", displayName: "Bob Test", isActive: true, attendanceGroup: "BT" },
    ] } },
    "@/lib/emailNotice": { normalizeEmailList() { throw new Error("Mail is forbidden in this fixture") }, sendNoticeEmail() { throw new Error("Mail is forbidden in this fixture") } },
    "@/lib/attendanceSync": { runAttendanceSync() { throw new Error("Sync is forbidden in this fixture") } },
  }
  const code = await build({
    absWorkingDir: root, entryPoints: ["app/api/admin/attendance/route.ts"], bundle: true, write: false,
    platform: "node", format: "cjs", target: "node24", logLevel: "warning",
    define: { "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://attendance-fixture.invalid"', "process.env.SUPABASE_SERVICE_ROLE_KEY": '"synthetic-service-key"' },
    plugins: [{ name: "strict-local-backend-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path: name }) => Object.hasOwn(boundaries, name) ? { path: name, external: true } : undefined)
    } }],
  })
  // attendanceData's requireEnv indexes process.env dynamically. Inject only the
  // synthetic environment; never read or pass through the operator's env files.
  const loaded = { exports: {} }
  const errors = []
  new Function("require", "module", "exports", "process", "console", code.outputFiles[0].text)((name) => {
    if (Object.hasOwn(boundaries, name)) return boundaries[name]
    assert.equal(name, "node:crypto"); return require(name)
  }, loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://attendance-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key" } },
  { error: (...args) => errors.push(args.map(String).join(" ")), log: () => undefined })
  return { db, route: loaded.exports, trace, errors, currentYear, currentMonth, closedYear,
    fail() { failNext = true }, hold() { holdNext = true }, release() { assert.ok(release); release() },
    async saved() { return jsonRows((await db.query("select * from public.attendance_monthly_confirmations order by year,month,person_id")).rows) },
  }
}

async function main() {
  const baselineRef = process.argv.find((value) => value.startsWith("--baseline-client-ref="))?.slice("--baseline-client-ref=".length)
  if (baselineRef && !/^[a-f0-9]{40}$/i.test(baselineRef)) throw new Error("Baseline client ref must be an exact commit SHA")
  const app = await backend()
  let browser
  let server
  try {
    const authCode = `import {ADMIN_PAGE_DEFINITIONS} from "${path.join(root, "lib/adminPages")}";
      export function usePathname(){return "/admin/attendancerecord"}
      export function useRouter(){return {push(){},replace(){},refresh(){}}}
      export function useSimpleAdminAuth(){return {loading:false,authenticated:true,resetRequired:false,role:"VIEW",permissions:{"attendance-record":"view"},pages:ADMIN_PAGE_DEFINITIONS}}`
    const entry = `import React from "react"; import {createRoot} from "react-dom/client";
      import {AdminRouteGuard} from "./components/AdminRouteGuard";
      import AttendanceRecordClient from "./app/admin/attendancerecord/AttendanceRecordClient";
      createRoot(document.getElementById("root")).render(<main className="fc-admin-scope"><AdminRouteGuard><AttendanceRecordClient/></AdminRouteGuard></main>);`
    const bundle = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, loader: "tsx" },
      bundle: true, write: false, outdir: "attendance-persistence-fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
      define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-auth-only", setup(builder) {
        builder.onResolve({ filter: /^(?:@\/lib\/useSimpleAdminAuth|next\/navigation)$/ }, () => ({ path: "attendance-auth", namespace: "fixture" }))
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: authCode, loader: "ts", resolveDir: root }))
        if (baselineRef) builder.onLoad({ filter: /\/AttendanceRecordClient\.tsx$/ }, ({ path: filename }) => ({
          contents: execFileSync("git", ["show", `${baselineRef}:app/admin/attendancerecord/AttendanceRecordClient.tsx`], { cwd: root, encoding: "utf8" }),
          loader: "tsx", resolveDir: path.dirname(filename),
        }))
      } }] })
    const assets = new Map(bundle.outputFiles.map((file) => [`/${path.basename(file.path)}`, file.contents]))
    const script = [...assets.keys()].find((key) => key.endsWith(".js"))
    const apiRequests = []
    server = http.createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url, "http://127.0.0.1").pathname
        if (pathname === "/api/admin/attendance") {
          const chunks = []; for await (const chunk of request) chunks.push(chunk)
          const body = Buffer.concat(chunks).toString()
          const input = new Request(`http://127.0.0.1${request.url}`, { method: request.method,
            headers: request.headers, ...(request.method === "GET" ? {} : { body }) })
          const result = await app.route[request.method](input)
          apiRequests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null, status: result.status })
          response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(await result.text()); return
        }
        assert.equal(request.method, "GET")
        const asset = assets.get(pathname)
        response.setHeader("Content-Type", asset ? pathname.endsWith(".css") ? "text/css" : "text/javascript" : "text/html")
        response.end(asset || `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="${script}"></script></body></html>`)
      } catch (error) { response.writeHead(500); response.end(error.message) }
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const { chromium } = require("playwright")
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const errors = []; const external = []
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === base) return route.continue()
      external.push(route.request().url()); return route.abort()
    })
    const page = await context.newPage(); page.setDefaultTimeout(10000)
    page.on("pageerror", (error) => errors.push(error.message))
    const rows = (code) => page.locator("tbody tr").filter({ has: page.locator("th strong,td strong").filter({ hasText: new RegExp(`^${code}$`) }) })
    await page.goto(base)
    await page.getByRole("button", { name: "MONTHLY STATEMENT", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[aria-label="Monthly attendance year"]').disabled)
    await page.getByLabel("Monthly attendance year").selectOption(String(app.closedYear))
    await rows("AT").first().getByRole("button", { name: "CONFIRM", exact: true }).waitFor()
    assert.equal(await rows("BT").first().getByRole("button", { name: "CONFIRM", exact: true }).isDisabled(), true)
    await rows("AT").first().getByRole("button", { name: "CONFIRM", exact: true }).click()
    await rows("AT").first().getByText("CONFIRMED", { exact: true }).waitFor()
    let saved = await app.saved()
    assert.equal(saved.length, 1); assert.equal(saved[0].person_id, ownId); assert.equal(saved[0].year, app.closedYear)
    assert.equal(saved[0].month, 1); assert.equal(saved[0].status, "confirmed"); assert.equal(saved[0].confirmed_by, "alice@example.invalid")
    assert.match(saved[0].id, /^[0-9a-f-]{36}$/); assert.ok(saved[0].confirmed_at)
    await page.reload()
    await page.getByRole("button", { name: "MONTHLY STATEMENT", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[aria-label="Monthly attendance year"]').disabled)
    await page.getByLabel("Monthly attendance year").selectOption(String(app.closedYear))
    await rows("AT").first().getByText("CONFIRMED", { exact: true }).waitFor()
    console.log("PASS: actual View page -> guard -> real API/data helpers -> constrained SQL row -> real GET -> confirmation survives reload")

    app.fail()
    await rows("AT").nth(1).getByRole("button", { name: "CONFIRM", exact: true }).click()
    await page.getByText("Could not update attendance records.", { exact: false }).waitFor()
    assert.equal((await app.saved()).length, 1, "failed SQL write must not manufacture a confirmation")
    await rows("AT").nth(1).getByRole("button", { name: "CONFIRM", exact: true }).click()
    await rows("AT").nth(1).getByText("CONFIRMED", { exact: true }).waitFor()
    saved = await app.saved(); assert.equal(saved.length, 2); assert.equal(saved[1].month, 2)
    assert.equal(app.errors.length, 1); assert.match(app.errors[0], /Synthetic storage outage/)
    console.log("PASS: real storage error returns a safe error, leaves SQL unchanged, and retry persists and refreshes the correct month")

    app.hold()
    await rows("AT").nth(2).getByRole("button", { name: "CONFIRM", exact: true }).click()
    await page.getByRole("button", { name: "SAVING…", exact: true }).waitFor()
    await page.getByLabel("Monthly attendance year").selectOption(String(app.currentYear))
    await rows("AT").last().getByText("OPEN", { exact: true }).waitFor()
    app.release()
    await page.getByText("March attendance confirmed.", { exact: false }).waitFor()
    await page.waitForFunction(() => !document.querySelector('[aria-label="Monthly attendance year"]').disabled)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await rows("AT").last().getByText("OPEN", { exact: true }).count(), 1)
    saved = await app.saved(); assert.equal(saved.length, 3); assert.equal(saved[2].year, app.closedYear); assert.equal(saved[2].month, 3)
    console.log("PASS: held real API/SQL confirmation saves the requested year without replacing the newly selected year's UI")

    const attack = (confirmation, permission = "view") => fetch(`${base}/api/admin/attendance`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-test-permission": permission },
      body: JSON.stringify({ action: "save-confirmation", confirmation }) })
    const payload = { personId: ownId, year: app.closedYear, month: 4, status: "confirmed", sourceRevision: 0 }
    assert.equal((await attack({ ...payload, personId: otherId })).status, 403)
    assert.equal((await attack({ ...payload, status: "pending" })).status, 403)
    assert.equal((await attack({ ...payload, year: app.currentYear, month: app.currentMonth })).status, 400)
    assert.equal((await attack(payload, "none")).status, 403)
    assert.equal((await app.saved()).length, 3)
    const before = apiRequests.length
    assert.equal((await attack({ ...payload, personId: otherId }, "edit")).status, 200)
    assert.equal((await app.saved()).filter((row) => row.person_id === otherId).length, 1)
    assert.equal(apiRequests.length, before + 1)
    assert.deepEqual(errors, []); assert.deepEqual(external, [])
    assert.ok(app.trace.filter((entry) => entry.operation === "select" && entry.table === "attendance_monthly_confirmations").length >= 3)
    console.log("PASS: actual server ownership/open-month/reset/no-access fences deny without writes; editor exception remains; no external requests")

    const retrospectiveNote = "Retrospective system confirmation; no DingTalk verification or staff approval."
    await app.db.query(`insert into public.attendance_monthly_confirmations
      (person_id,year,month,status,confirmed_at,confirmed_by,note,created_by,updated_by)
      values ($1,$2,5,'confirmed',now(),'system:attendance-retrospective-confirm',$3,
        'system:attendance-retrospective-confirm','system:attendance-retrospective-confirm')`,
    [otherId, app.closedYear, retrospectiveNote])
    await page.reload()
    await page.getByRole("button", { name: "MONTHLY STATEMENT", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[aria-label="Monthly attendance year"]').disabled)
    await page.getByLabel("Monthly attendance year").selectOption(String(app.closedYear))
    const retrospectiveBadge = rows("BT").nth(4).getByText("SYSTEM CONFIRMED", { exact: true })
    await retrospectiveBadge.waitFor()
    assert.match(await retrospectiveBadge.getAttribute("title"), /no DingTalk verification or staff approval/)
    assert.match(await retrospectiveBadge.getAttribute("aria-label"), /no DingTalk verification or staff approval/)
    assert.equal((await app.saved()).filter((row) => row.person_id === otherId && row.month === 5).length, 1)
    console.log("PASS: a distinct audited retrospective actor displays SYSTEM CONFIRMED with its source caveat after reload")
    await context.close()
  } finally {
    if (browser) await browser.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await app.db.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
