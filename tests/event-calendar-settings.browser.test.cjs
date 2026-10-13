// Actual Event Calendar -> HTTP route -> CAS persistence -> canonical response.
// Only auth, the database transport and unrelated external integrations are synthetic.
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { build } = require("esbuild")
const { chromium } = require("playwright")
const root = path.resolve(__dirname, "..")
// Optional read-only reproduction of the first failure on the released base.
const baselinePage = process.env.CALENDAR_TEST_BASELINE === "1"
  ? require("node:child_process").execFileSync("git", ["show", "2325abb6f0e25cf74b91b2b06f5f901712df359d:app/admin/eventcalendar/page.tsx"], { cwd: root, encoding: "utf8" })
  : null

async function main() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  const originalEvent = { id: "synthetic-event", title: "MULTI DAY SYNTHETIC EVENT", startDate: today, endDate: today, people: ["OL"], uncertainPeople: [], tags: [], eventType: "Unclassified" }
  const initialPayload = () => ({ events: [originalEvent], people: ["OL", "VL"], emailRecipientsText: "office@example.test", deletedEventIds: ["keep-tombstone"], syntheticUnrelated: { keep: true } })
  let row, writes, requests, failReads, failWrites, hold, release, pending, deliveries, calendarKey
  function reset(payload = initialPayload(), key = "event-calendar") {
    calendarKey = key
    row = payload === null ? null : { key, payload: structuredClone(payload), updated_at: "2026-10-12T00:00:00.000Z" }
    writes = 0; requests = []; failReads = false; failWrites = false; hold = false; release = null; pending = 0; deliveries = []
  }
  reset()
  const client = { from(table) {
    assert.equal(table, "office_calendar_store")
    let mode = "read", values, expected
    const q = {
      select() { return q },
      eq(field, value) { if (field === "key") assert.equal(value, calendarKey); if (field === "updated_at") expected = value; return q },
      update(value) { mode = "update"; values = value; return q },
      insert(value) { mode = "insert"; values = value; return q },
      async maybeSingle() {
        await new Promise(resolve => setImmediate(resolve))
        if (mode === "read") return failReads ? { data: null, error: new Error("Synthetic read unavailable") } : { data: structuredClone(row), error: null }
        if (failWrites) return { data: null, error: new Error("Synthetic write unavailable") }
        if (mode === "insert" && row) return { data: null, error: { code: "23505" } }
        if (mode === "update" && (!row || expected !== row.updated_at)) return { data: null, error: null }
        row = structuredClone(values); writes += 1
        return { data: { payload: structuredClone(row.payload) }, error: null }
      },
    }
    return q
  } }
  const mocks = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@supabase/supabase-js": { createClient: () => client },
    "@/lib/adminAuth": { getAdminSession: async () => ({ authenticated: true }), hasAdminPagePermission: () => true, requireAdminPagePermission: async () => ({ authenticated: true }) },
    "@/lib/adminAudit": { createAdminAuditContext: () => ({}), createAdminAuditedSupabaseClient: () => client },
    "@/lib/calendarStaff": { loadCalendarStaffDirectory: async () => ["OL", "VL", "CY"].map(code => ({ code, name: code, email: `${code.toLowerCase()}@example.test` })), resolveCalendarStaffRecipients: codes => ({ recipients: [...new Set(codes.filter(code => ["OL", "VL", "CY"].includes(code)).map(code => `${code.toLowerCase()}@example.test`))], unresolved: codes.filter(code => !["OL", "VL", "CY"].includes(code)) }) },
    "@/lib/calendarDelivery": { deliverCalendarReminder: async delivery => { deliveries.push(delivery); return { status: "delivered", sent: 1 } } },
  }
  const routeBundle = await build({ absWorkingDir: root, entryPoints: ["app/api/office-calendar-store/[key]/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", target: "node24", logLevel: "warning", plugins: [{ name: "owned-service-transports", setup(b) { b.onResolve({ filter: /^(?:next\/server|@supabase\/supabase-js|@\/lib\/(?:adminAuth|adminAudit|calendarStaff))$/ }, args => ({ path: args.path, external: true })) } }] })
  const loaded = { exports: {} }
  new Function("require", "module", "exports", "process", routeBundle.outputFiles[0].text)(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } })
  const leaveBundle = await build({ absWorkingDir: root, entryPoints: ["app/api/event-calendar/leave-request/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", target: "node24", logLevel: "warning", plugins: [{ name: "synthetic-email-transport", setup(b) { b.onResolve({ filter: /^(?:next\/server|@\/lib\/(?:adminAuth|calendarStaff|calendarDelivery))$/ }, args => ({ path: args.path, external: true })) } }] })
  const leaveRoute = { exports: {} }
  new Function("require", "module", "exports", leaveBundle.outputFiles[0].text)(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), leaveRoute, leaveRoute.exports)
  const holidayBundle = await build({ absWorkingDir: root, entryPoints: ["app/api/event-calendar/public-holidays/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", target: "node24", logLevel: "warning", plugins: [{ name: "synthetic-holiday-transport", setup(b) { b.onResolve({ filter: /^(?:next\/server|@\/lib\/(?:adminAuth|adminAudit))$/ }, args => ({ path: args.path, external: true })) } }] })
  const holidayRoute = { exports: {} }
  new Function("require", "module", "exports", holidayBundle.outputFiles[0].text)(name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), holidayRoute, holidayRoute.exports)
  const fixtureMocks = path.join(root, "tests/fixtures/event-calendar-mocks.ts")
  const entry = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import EventCalendarPage from ${JSON.stringify(path.join(root, "app/admin/eventcalendar/page.tsx"))};
    import { AdminRouteGuard } from ${JSON.stringify(path.join(root, "components/AdminRouteGuard.tsx"))};
    import { installEventCalendarHarness } from ${JSON.stringify(fixtureMocks)};
    const nativeFetch = window.fetch.bind(window);
    installEventCalendarHarness();
    const integrationFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (["/api/office-calendar-store/event-calendar", "/api/event-calendar/leave-request", "/api/event-calendar/public-holidays"].includes(url.pathname)) return nativeFetch(input, init);
      return integrationFetch(input, init);
    };
    createRoot(document.getElementById("root")).render(<React.StrictMode><main className="fc-admin-scope"><AdminRouteGuard><EventCalendarPage /></AdminRouteGuard></main></React.StrictMode>);
  `
  const bundle = await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, sourcefile: "event-calendar-settings-fixture.tsx", loader: "tsx" }, bundle: true, write: false, outdir: "fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-auth", setup(b) {
    b.onResolve({ filter: /^@\/lib\/useSimpleAdminAuth$|^next\/navigation$/ }, () => ({ path: fixtureMocks }))
    if (baselinePage) b.onLoad({ filter: /\/app\/admin\/eventcalendar\/page\.tsx$/ }, () => ({ contents: baselinePage, loader: "tsx", resolveDir: path.join(root, "app/admin/eventcalendar") }))
  } }] })
  const js = bundle.outputFiles.find(file => file.path.endsWith(".js")).contents
  const taskMocks = path.join(root, "tests/fixtures/task-calendar-mocks.ts")
  const taskEntry = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import TaskCalendarPage from ${JSON.stringify(path.join(root, "app/admin/taskcalendar/page.tsx"))};
    import { AdminRouteGuard } from ${JSON.stringify(path.join(root, "components/AdminRouteGuard.tsx"))};
    import { installTaskCalendarHarness } from ${JSON.stringify(taskMocks)};
    const nativeFetch = window.fetch.bind(window);
    installTaskCalendarHarness();
    window.fetch = nativeFetch;
    createRoot(document.getElementById("root")).render(<React.StrictMode><main className="fc-admin-scope"><AdminRouteGuard><TaskCalendarPage /></AdminRouteGuard></main></React.StrictMode>);
  `
  const taskBundle = await build({ absWorkingDir: root, stdin: { contents: taskEntry, resolveDir: root, sourcefile: "task-calendar-roundtrip-fixture.tsx", loader: "tsx" }, bundle: true, write: false, outdir: "fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "synthetic-task-auth", setup(b) { b.onResolve({ filter: /^@\/lib\/useSimpleAdminAuth$|^next\/navigation$/ }, () => ({ path: taskMocks })) } }] })
  const taskJs = taskBundle.outputFiles.find(file => file.path.endsWith(".js")).contents
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>:root{--fc-admin-panel-text:#222;--fc-admin-panel-bg:#fff;--fc-admin-page-bg:#eee;--fc-admin-border:#bbb;--fc-admin-button-bg:#eee;--fc-admin-button-text:#222;--fc-admin-link:#06c;--fc-admin-primary-button-bg:#06c;--fc-admin-primary-button-text:#fff;--fc-row-bg:#fafafa;--fc-admin-muted:#555}*{box-sizing:border-box}body{margin:0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname
      if (["/api/office-calendar-store/event-calendar", "/api/office-calendar-store/task-calendar", "/api/event-calendar/leave-request", "/api/event-calendar/public-holidays"].includes(pathname)) {
        let body = ""; for await (const chunk of request) body += chunk
        requests.push({ method: request.method, path: pathname, body: body ? JSON.parse(body) : null })
        pending += 1
        if (hold && request.method !== "GET") await new Promise(resolve => { release = resolve })
        const handlers = pathname.endsWith("leave-request") ? leaveRoute.exports : pathname.endsWith("public-holidays") ? holidayRoute.exports : loaded.exports
        const result = await handlers[request.method](new Request(`https://example.test${request.url}`, { method: request.method, ...(body ? { headers: { "Content-Type": "application/json" }, body } : {}) }), { params: Promise.resolve({ key: pathname.split("/").at(-1) }) })
        response.statusCode = result.status; response.setHeader("Content-Type", "application/json"); response.end(await result.text()); pending -= 1
        return
      }
      const isScript = ["/fixture.js", "/task-fixture.js"].includes(pathname)
      response.setHeader("Content-Type", isScript ? "text/javascript" : "text/html")
      response.end(pathname === "/fixture.js" ? js : pathname === "/task-fixture.js" ? taskJs : new URL(request.url, "http://localhost").searchParams.get("kind") === "task" ? html.replace("/fixture.js", "/task-fixture.js") : html)
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ message: error.message })); pending -= 1 }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    const context = await browser.newContext({ viewport: { width: 1360, height: 1000 }, timezoneId: "Asia/Hong_Kong" })
    let external = 0
    await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external += 1; return route.abort() })
    const page = await context.newPage(); page.setDefaultTimeout(8000)
    const errors = [], dialogs = []
    let acceptConfirmation = true
    function attachPage(target) {
      target.on("pageerror", error => errors.push(error.message))
      target.on("dialog", async dialog => {
        dialogs.push({ type: dialog.type(), message: dialog.message() })
        if (dialog.type() === "confirm" && !acceptConfirmation) await dialog.dismiss(); else await dialog.accept()
      })
    }
    attachPage(page)
    const button = name => page.getByRole("button", { name, exact: true })
    const emailHeading = () => page.getByRole("heading", { name: "Event Update Email Recipients", exact: true })
    const emailField = () => page.locator('textarea[placeholder="name@company.com"]')
    async function waitFor(check) { for (let i = 0; i < 100; i += 1) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error("Synthetic boundary did not arrive") }
    async function load(target = page) { await target.goto(origin); await target.getByText("MULTI DAY SYNTHETIC EVENT", { exact: true }).waitFor(); await waitFor(() => pending === 0) }
    async function openEmail(target = page) { await target.getByRole("button", { name: "Event calendar settings", exact: true }).click(); await target.getByRole("button", { name: "Edit Email List", exact: true }).click(); await target.getByRole("heading", { name: "Event Update Email Recipients", exact: true }).waitFor() }
    async function openPeople() { await button("Event calendar settings").click(); await button("Edit People List").click(); await page.getByRole("heading", { name: "People Columns", exact: true }).waitFor() }

    await load(); await openEmail(); await emailField().fill("sent-a@example.test"); hold = true; await button("Save").click(); await waitFor(() => Boolean(release))
    // Baseline proof: an accepted second draft disappeared on the first save's response.
    if (!await emailField().isDisabled()) {
      await emailField().fill("newer-b@example.test"); release(); await waitFor(() => pending === 0); await page.waitForTimeout(60)
      console.log("RED BOUNDARY:", JSON.stringify({ sent: row.payload.emailRecipientsText, acceptedNewerTyping: "newer-b@example.test", editorStillOpen: await emailHeading().count() === 1 }))
      assert.equal(await emailHeading().count(), 1, "a delayed settings save must not silently close and discard a newer accepted draft")
    } else {
      assert.equal(await button("Cancel").isDisabled(), true, "pending settings save cannot close its owner dialog")
      assert.equal(await button("Saving").isDisabled(), true)
      release(); await emailHeading().waitFor({ state: "hidden" }); await openEmail(); assert.equal(await emailField().inputValue(), "sent-a@example.test"); await button("Cancel").click()
    }
    assert.equal(writes, 1)
    assert.deepEqual(row.payload.events, initialPayload().events)
    assert.deepEqual(row.payload.syntheticUnrelated, { keep: true })
    console.log("PASS: pending email-list save cannot accept and discard newer typing or close its owner dialog; canonical roundtrip preserves unrelated data")

    reset(); await load(); await openPeople(); await page.locator("textarea").fill("CY\nOL\nCY"); hold = true; await button("Save People").click(); await waitFor(() => Boolean(release))
    assert.equal(await page.locator("textarea").isDisabled(), true)
    assert.equal(await button("Cancel").isDisabled(), true)
    assert.equal(await button("Saving").isDisabled(), true)
    hold = false; release(); await page.getByRole("heading", { name: "People Columns", exact: true }).waitFor({ state: "hidden" })
    assert.deepEqual(row.payload.people, ["CY", "OL"]); assert.equal(row.payload.emailRecipientsText, "office@example.test"); assert.equal(writes, 1)
    await load(); await openPeople(); assert.equal(await page.locator("textarea").inputValue(), "CY\nOL"); await button("Cancel").click()
    console.log("PASS: pending people save owns its draft; deduplicated CY columns roundtrip without changing recipients")

    for (const mode of ["filled", "disabled", "absent"]) {
      const payload = initialPayload(); if (mode === "disabled") payload.emailRecipientsText = ""; if (mode === "absent") delete payload.emailRecipientsText
      reset(payload); await load(); await openEmail(); const before = structuredClone(row); const dialogCount = dialogs.length
      await button("Save").click(); await emailHeading().waitFor({ state: "hidden" })
      assert.equal(writes, 0); assert.deepEqual(row, before); assert.equal(dialogs.length, dialogCount)
    }
    console.log("PASS: unchanged filled, disabled and absent recipient settings are genuinely read-only through real HTTP persistence")

    reset(); await load(); await openEmail(); await emailField().fill(""); acceptConfirmation = false; await button("Save").click()
    assert.equal(await emailHeading().count(), 1); assert.equal(await emailField().inputValue(), ""); assert.equal(writes, 0); assert.equal(row.payload.emailRecipientsText, "office@example.test")
    acceptConfirmation = true; await button("Save").click(); await emailHeading().waitFor({ state: "hidden" })
    assert.equal(writes, 1); assert.equal(row.payload.emailRecipientsText, ""); assert.deepEqual(row.payload.deletedEventIds, ["keep-tombstone"])
    assert.equal(requests.find(request => request.method === "PATCH").body.confirmEmailRecipientsClear, true)
    await load(); await openEmail(); assert.equal(await emailField().inputValue(), ""); await button("Cancel").click()
    console.log("PASS: clearing requires acceptance, persists only after acceptance, and reload remains explicitly disabled")

    for (const kind of ["email", "people"]) {
      reset(); await load(); if (kind === "email") await openEmail(); else await openPeople()
      const field = kind === "email" ? emailField() : page.locator("textarea")
      const heading = kind === "email" ? emailHeading() : page.getByRole("heading", { name: "People Columns", exact: true })
      const draft = kind === "email" ? "retry@example.test" : "CY\nOL"
      await field.fill(draft); failWrites = true; const before = structuredClone(row); const alertsBefore = dialogs.filter(dialog => dialog.type === "alert").length
      await button(kind === "email" ? "Save" : "Save People").click(); await waitFor(() => dialogs.filter(dialog => dialog.type === "alert").length === alertsBefore + 1)
      assert.equal(await heading.count(), 1); assert.equal(await field.inputValue(), draft); assert.equal(await field.isDisabled(), false); assert.deepEqual(row, before); assert.equal(writes, 0)
      failWrites = false; await button(kind === "email" ? "Save" : "Save People").click(); await heading.waitFor({ state: "hidden" }); assert.equal(writes, 1)
    }
    console.log("PASS: settings write failures retain their exact editable drafts and committed state; explicit retry succeeds")

    reset(); await load(); await openEmail(); const second = await context.newPage(); attachPage(second); await load(second); await openEmail(second)
    const secondEmail = second.locator('textarea[placeholder="name@company.com"]')
    await emailField().fill(""); await secondEmail.fill("stale@example.test"); await button("Save").click(); await emailHeading().waitFor({ state: "hidden" })
    let alertsBefore = dialogs.filter(dialog => dialog.type === "alert").length
    await second.getByRole("button", { name: "Save", exact: true }).click(); await waitFor(() => dialogs.filter(dialog => dialog.type === "alert").length === alertsBefore + 1)
    assert.equal(row.payload.emailRecipientsText, ""); assert.equal(writes, 1); assert.equal(await secondEmail.inputValue(), "stale@example.test")
    alertsBefore += 1; await second.getByRole("button", { name: "Save", exact: true }).click(); await waitFor(() => dialogs.filter(dialog => dialog.type === "alert").length === alertsBefore + 1)
    assert.equal(row.payload.emailRecipientsText, ""); assert.equal(writes, 1)
    await second.getByRole("button", { name: "Cancel", exact: true }).click(); await openEmail(second); assert.equal(await secondEmail.inputValue(), "")
    await secondEmail.fill("fresh@example.test"); await second.getByRole("button", { name: "Save", exact: true }).click(); await second.getByRole("heading", { name: "Event Update Email Recipients", exact: true }).waitFor({ state: "hidden" })
    assert.equal(row.payload.emailRecipientsText, "fresh@example.test"); assert.equal(writes, 2); await second.close()
    console.log("PASS: two real tabs cannot undo a newer clear; stale draft stays visible, no automatic rebasing, reopen captures the current version")

    reset(); await load(); await openPeople(); const third = await context.newPage(); attachPage(third); await load(third); await openEmail(third)
    await page.locator("textarea").fill("CY\nOL"); await third.locator('textarea[placeholder="name@company.com"]').fill("other-field@example.test")
    await button("Save People").click(); await page.getByRole("heading", { name: "People Columns", exact: true }).waitFor({ state: "hidden" })
    await third.getByRole("button", { name: "Save", exact: true }).click(); await third.getByRole("heading", { name: "Event Update Email Recipients", exact: true }).waitFor({ state: "hidden" })
    assert.deepEqual(row.payload.people, ["CY", "OL"]); assert.equal(row.payload.emailRecipientsText, "other-field@example.test"); assert.deepEqual(row.payload.events, initialPayload().events); assert.deepEqual(row.payload.syntheticUnrelated, { keep: true }); assert.equal(writes, 2)
    await third.close()
    console.log("PASS: concurrent tabs saving different settings merge both changes through real per-setting versions and CAS persistence")

    reset(); await load(); await page.getByText("MULTI DAY SYNTHETIC EVENT", { exact: true }).dblclick(); await page.getByLabel("Event", { exact: true }).fill("CANONICAL EDITED EVENT")
    hold = true; await button("Save").click(); await waitFor(() => Boolean(release)); assert.equal(await page.getByLabel("Event", { exact: true }).isDisabled(), true); assert.equal(await button("Cancel").isDisabled(), true)
    hold = false; release(); await page.getByRole("heading", { name: "Send Event Update?", exact: true }).waitFor(); assert.equal(row.payload.events[0].title, "CANONICAL EDITED EVENT"); assert.equal(row.payload.emailRecipientsText, "office@example.test"); assert.equal(writes, 1)
    assert.equal(await page.evaluate(() => window.__eventCalendarHarness.requests.filter(request => request.path.endsWith("email-notify")).length), 0)
    await button("No").click(); assert.equal(await page.evaluate(() => window.__eventCalendarHarness.requests.filter(request => request.path.endsWith("email-notify")).length), 0)
    await page.getByText("CANONICAL EDITED EVENT", { exact: true }).dblclick(); await page.getByLabel("Event", { exact: true }).fill("UNSAVED FAILED EDIT"); failWrites = true; const alertsBeforeEdit = dialogs.filter(dialog => dialog.type === "alert").length
    await button("Save").click(); await waitFor(() => dialogs.filter(dialog => dialog.type === "alert").length === alertsBeforeEdit + 1); assert.equal(await page.getByLabel("Event", { exact: true }).inputValue(), "UNSAVED FAILED EDIT"); assert.equal(await page.getByRole("heading", { name: "Send Event Update?", exact: true }).count(), 0); assert.equal(row.payload.events[0].title, "CANONICAL EDITED EVENT"); assert.equal(writes, 1); await button("Cancel").click()
    console.log("PASS: ordinary edit locks its pending draft, prompts only after a real commit, sends nothing on No, and retains a failed edit without an email prompt")

    reset(); failReads = true; await page.goto(origin); await page.getByText("Shared calendar unavailable", { exact: true }).waitFor(); assert.equal(await button("Add Event").count(), 0); assert.equal(writes, 0); assert.equal(requests.filter(request => request.method !== "GET").length, 0)
    console.log("PASS: failed shared-store reads block editing and never write empty/default settings")

    reset(); await load(); await button("Add Event").click(); await button("Add Recurrent Event").click(); await page.getByLabel("Event", { exact: true }).fill("RECURRENT SENT A")
    hold = true; await button("Save").click(); await waitFor(() => Boolean(release))
    if (!await page.getByLabel("Event", { exact: true }).isDisabled()) {
      await page.getByLabel("Event", { exact: true }).fill("RECURRENT NEWER B"); hold = false; release(); await waitFor(() => pending === 0); await page.waitForTimeout(60)
      console.log("RED RECURRENT BOUNDARY:", JSON.stringify({ sent: row.payload.events.find(event => event.title.startsWith("RECURRENT"))?.title, acceptedNewerTyping: "RECURRENT NEWER B", editorStillOpen: await page.getByRole("heading", { name: "Recurrent Event", exact: true }).count() === 1 }))
      assert.equal(await page.getByRole("heading", { name: "Recurrent Event", exact: true }).count(), 1, "a delayed recurrent save must not silently close and discard a newer accepted draft")
    } else {
      assert.equal(await button("Cancel").isDisabled(), true)
      hold = false; release(); await page.getByRole("heading", { name: "Send Event Update?", exact: true }).waitFor(); await button("No").click()
    }
    assert.equal(writes, 1); assert.equal(row.payload.events.filter(event => event.title === "RECURRENT SENT A").length, 1)
    console.log("PASS: recurrent saves cannot accept then discard a newer draft or close a pending editor")

    reset(); await load(); await button("Send Leave Request").click(); await page.getByLabel("Reason (Non Compulsory)", { exact: true }).fill("LEAVE SENT A"); hold = true; await button("Send").click(); await waitFor(() => Boolean(release))
    const leaveField = () => page.locator("textarea")
    if (!await leaveField().isDisabled()) {
      await leaveField().fill("LEAVE NEWER B"); hold = false; release(); await button("Sent").waitFor(); assert.match(deliveries[0].html, /LEAVE SENT A/); assert.doesNotMatch(deliveries[0].html, /LEAVE NEWER B/)
      console.log("RED LEAVE BOUNDARY:", JSON.stringify({ actualSubmittedReason: "LEAVE SENT A", acceptedNewerTyping: await leaveField().inputValue(), displayedStatus: "Sent" }))
      assert.equal(await leaveField().inputValue(), "LEAVE SENT A", "leave confirmation must not label a different, unsent reason as Sent")
    } else {
      assert.equal(await button("Cancel").isDisabled(), true); hold = false; release(); await button("Sent").waitFor(); assert.equal(await leaveField().inputValue(), "LEAVE SENT A")
    }
    assert.equal(deliveries.length, 1); assert.equal(writes, 0)
    await button("Cancel").click(); await button("Send Leave Request").click(); await page.getByLabel("Reason (Non Compulsory)", { exact: true }).fill("NEW UNSENT LEAVE DRAFT"); await page.waitForTimeout(1000)
    assert.equal(await page.getByRole("heading", { name: "Leave Request", exact: true }).count(), 1, "an old sent dialog's timer must not close a newly opened draft")
    assert.equal(await leaveField().inputValue(), "NEW UNSENT LEAVE DRAFT"); await button("Cancel").click()
    console.log("PASS: leave request confirmation matches the submitted draft; pending controls lock; old completion cannot close a new draft; synthetic delivery only")

    reset(); await load()
    for (const selection of ["Review HK Holidays", "Review US Bank, Taiwan, Singapore Holidays"]) {
      await button("Event calendar settings").click(); await button(selection).click(); await page.getByRole("heading", { name: "Review Holiday Updates", exact: true }).waitFor()
      const before = writes; await button("Apply Reviewed Updates").click(); await page.getByRole("heading", { name: "Review Holiday Updates", exact: true }).waitFor({ state: "hidden" }); assert.equal(writes, before + 1)
      assert.deepEqual(row.payload.people, ["OL", "VL"]); assert.equal(row.payload.emailRecipientsText, "office@example.test"); assert.deepEqual(row.payload.syntheticUnrelated, { keep: true }); assert.equal(new Set(row.payload.events.map(event => event.id)).size, row.payload.events.length)
      await button("Event calendar settings").click(); await button(selection).click(); await page.getByRole("heading", { name: "Review Holiday Updates", exact: true }).waitFor()
      assert.equal(await button("Apply Reviewed Updates").isDisabled(), true); assert.equal(writes, before + 1); await button("Cancel").click()
    }
    assert.equal(writes, 2)
    const usEvents = row.payload.events.filter(event => event.holidaySource?.country === "US"); assert.ok(usEvents.every(event => event.title.startsWith("BANK HOLIDAY - USA (FEDERAL RESERVE)")))
    const twEvents = row.payload.events.filter(event => event.holidaySource?.country === "TW"); assert.ok(twEvents.every(event => event.title.startsWith("GOVERNMENT HOLIDAY - TAIWAN")))
    console.log("PASS: real holiday preview/apply performs one atomic CAS per reviewed group; all four countries retain settings; repeat previews are exact no-ops with no duplicate events")

    reset(); await load(); await button("Event calendar settings").click(); await button("Review HK Holidays").click(); await page.getByRole("heading", { name: "Review Holiday Updates", exact: true }).waitFor()
    row.payload.people = ["CY", "OL"]; row.updated_at = "2026-10-12T00:00:01.000Z"
    const alertsBeforeHoliday = dialogs.filter(dialog => dialog.type === "alert").length; await button("Apply Reviewed Updates").click(); await waitFor(() => dialogs.filter(dialog => dialog.type === "alert").length === alertsBeforeHoliday + 1)
    assert.equal(writes, 0); assert.equal(row.payload.events.length, 1); assert.deepEqual(row.payload.people, ["CY", "OL"]); assert.equal(row.payload.emailRecipientsText, "office@example.test")
    console.log("PASS: a settings change after holiday preview rejects the whole stale apply without partial calendar or recipient changes")

    reset(null); await page.goto(origin); await button("Add Event").waitFor(); await waitFor(() => pending === 0); assert.equal(row, null); assert.equal(writes, 0)
    await openEmail(); assert.equal(await emailField().inputValue(), ""); await button("Save").click(); await emailHeading().waitFor({ state: "hidden" }); assert.equal(row, null); assert.equal(writes, 0)
    console.log("PASS: missing shared-store row and unchanged blank recipients cannot bootstrap or clear live settings")

    const taskPayload = () => ({ tasks: [
      { id: "task-a", sourceRow: 1, scheduleType: "Monthly", daysOfMonth: [1, 16], months: [], notify: ["OL"], cc: ["VL"], task: "FIRST ROUNDTRIP TASK", remark: "Original note" },
      { id: "task-b", sourceRow: 2, scheduleType: "Weekly", dayOfWeek: 5, daysOfMonth: [], months: [], notify: ["VL"], cc: [], task: "SECOND ROUNDTRIP TASK", remark: "" },
    ], deletedTaskIds: ["keep-task-tombstone"], syntheticUnrelated: { keep: true } })
    const taskRow = (target, text) => target.locator("tbody tr").filter({ hasText: text })
    const taskModal = target => target.getByRole("dialog", { name: "Edit Task", exact: true })
    async function loadTask(target = page, empty = false) { await target.goto(`${origin}?kind=task`); await (empty ? target.getByText("No scheduled tasks.", { exact: true }) : taskRow(target, "FIRST ROUNDTRIP TASK")).waitFor(); await waitFor(() => pending === 0) }
    reset(taskPayload(), "task-calendar"); await loadTask(); await taskRow(page, "FIRST ROUNDTRIP TASK").locator("td").last().click(); assert.equal(await taskRow(page, "FIRST ROUNDTRIP TASK").getAttribute("aria-selected"), "true"); assert.equal(writes, 0)
    await taskRow(page, "FIRST ROUNDTRIP TASK").dblclick(); await taskModal(page).getByLabel("Task", { exact: true }).fill("CONFIRMED ROUNDTRIP TASK"); hold = true; failWrites = true; await button("Save").click(); await waitFor(() => Boolean(release))
    assert.equal(await taskModal(page).getByLabel("Task", { exact: true }).isDisabled(), true); assert.equal(await button("Cancel").isDisabled(), true); await page.keyboard.press("Escape"); assert.equal(await taskModal(page).isVisible(), true)
    hold = false; release(); await page.getByRole("alert").filter({ hasText: "Synthetic write unavailable" }).waitFor(); assert.equal(await taskModal(page).getByLabel("Task", { exact: true }).inputValue(), "CONFIRMED ROUNDTRIP TASK"); assert.equal(writes, 0); assert.equal(row.payload.tasks[0].task, "FIRST ROUNDTRIP TASK")
    failWrites = false; await button("Save").click(); await taskModal(page).waitFor({ state: "hidden" }); assert.equal(writes, 1); assert.equal(row.payload.tasks[0].task, "CONFIRMED ROUNDTRIP TASK"); assert.equal(await taskRow(page, "CONFIRMED ROUNDTRIP TASK").getAttribute("aria-selected"), "true"); assert.deepEqual(row.payload.syntheticUnrelated, { keep: true }); assert.deepEqual(row.payload.deletedTaskIds, ["keep-task-tombstone"])
    console.log("PASS: real task page/API/CAS row selection is read-only and survives successful edit; pending save locks controls; failed draft retries without data loss")

    reset(taskPayload(), "task-calendar"); await loadTask(); const taskSecond = await context.newPage(); attachPage(taskSecond); await loadTask(taskSecond)
    await taskRow(page, "FIRST ROUNDTRIP TASK").dblclick(); await taskRow(taskSecond, "FIRST ROUNDTRIP TASK").dblclick(); await taskModal(page).getByLabel("Task", { exact: true }).fill("TASK WINNER"); await taskModal(taskSecond).getByLabel("Task", { exact: true }).fill("TASK STALE DRAFT")
    await button("Save").click(); await taskModal(page).waitFor({ state: "hidden" }); await taskSecond.getByRole("button", { name: "Save", exact: true }).click(); await taskSecond.getByRole("alert").filter({ hasText: "changed" }).waitFor()
    assert.equal(row.payload.tasks[0].task, "TASK WINNER"); assert.equal(await taskModal(taskSecond).getByLabel("Task", { exact: true }).inputValue(), "TASK STALE DRAFT"); assert.equal(await taskRow(taskSecond, "TASK WINNER").count(), 1); assert.equal(writes, 1)
    await taskSecond.getByRole("button", { name: "Save", exact: true }).click(); await waitFor(() => pending === 0); assert.equal(writes, 1); assert.equal(row.payload.tasks[0].task, "TASK WINNER")
    await taskSecond.getByRole("button", { name: "Cancel", exact: true }).click(); await taskRow(taskSecond, "TASK WINNER").dblclick(); await taskModal(taskSecond).getByLabel("Task", { exact: true }).fill("TASK FRESH REOPEN"); await taskSecond.getByRole("button", { name: "Save", exact: true }).click(); await taskModal(taskSecond).waitFor({ state: "hidden" }); assert.equal(writes, 2); assert.equal(row.payload.tasks[0].task, "TASK FRESH REOPEN"); await taskSecond.close()
    console.log("PASS: two real task tabs retain the losing draft on conflict; repeated stale Save cannot overwrite; reopening latest explicitly permits the new edit")

    reset(taskPayload(), "task-calendar"); await loadTask(); const taskThird = await context.newPage(); attachPage(taskThird); await loadTask(taskThird)
    await taskRow(page, "FIRST ROUNDTRIP TASK").dblclick(); await taskRow(taskThird, "SECOND ROUNDTRIP TASK").dblclick(); await taskModal(page).getByLabel("Task", { exact: true }).fill("TASK A MERGED"); await taskModal(taskThird).getByLabel("Task", { exact: true }).fill("TASK B MERGED")
    await button("Save").click(); await taskModal(page).waitFor({ state: "hidden" }); await taskThird.getByRole("button", { name: "Save", exact: true }).click(); await taskModal(taskThird).waitFor({ state: "hidden" }); assert.deepEqual(row.payload.tasks.map(task => task.task), ["TASK A MERGED", "TASK B MERGED"]); assert.equal(writes, 2); assert.deepEqual(row.payload.deletedTaskIds, ["keep-task-tombstone"]); await taskThird.close()
    console.log("PASS: stale task tabs editing different records merge both changes through real per-task versions and the CAS retry loop")

    for (const payload of [null, { tasks: [], deletedTaskIds: [] }]) { reset(payload, "task-calendar"); await loadTask(page, true); assert.equal(writes, 0); assert.equal(await page.locator("tbody tr").count(), 0) }
    reset(taskPayload(), "task-calendar"); failReads = true; await page.goto(`${origin}?kind=task`); await page.getByText("Shared task calendar unavailable", { exact: true }).waitFor(); assert.equal(await button("Add New Task").count(), 0); assert.equal(writes, 0)
    console.log("PASS: actual task empty/missing-store responses never revive bundled tasks; failed reads disable editing without writes")
    assert.deepEqual(errors, []); assert.equal(external, 0)
  } finally { if (release) release(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
