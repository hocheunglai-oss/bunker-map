/* Actual built Outlook template page, using synthetic session and template data. */
const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { mkdtempSync } = require("node:fs")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const { chromium, webkit } = require("playwright")

const root = path.resolve(__dirname, "..")
const origin = "https://fcuno-template-built-fixture.invalid"
const out = mkdtempSync(path.join(os.tmpdir(), "fcuno-template-built-ui-"))
const templates = ["a", "b"].map((key) => ({
  id: `synthetic-${key}`, title: `Synthetic ${key.toUpperCase()}`, subject: "Synthetic subject",
  folder: "Outgoing / Bunker", sourcePath: "", from: "", to: "example@example.invalid",
  cc: "", bcc: "", bodyHtml: "<p>Synthetic body</p>", bodyText: "Synthetic body",
  tags: ["Outgoing", "Bunker"], slug: `synthetic-${key}`, isActive: true,
  placeholders: [], recipientResolution: {}, updatedAt: "2026-10-14T00:00:00.000Z", revision: 1,
}))

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function main() {
  const port = await freePort(), local = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { PATH: path.dirname(process.execPath), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
  })
  let serverLog = ""
  server.stdout.on("data", chunk => { serverLog += chunk })
  server.stderr.on("data", chunk => { serverLog += chunk })
  const cases = []
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw Error(`Next server exited: ${serverLog}`)
      try { if ((await fetch(`${local}/admin/outlooktemplates`)).status === 200) break } catch {}
      if (attempt === 99) throw Error(`Next server did not start: ${serverLog}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
      const executablePath = engine === "chromium" ? process.env.CHROME_EXECUTABLE_PATH : process.env.WEBKIT_EXECUTABLE_PATH
      const browser = await browserType.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
      try {
        for (const width of [1440, 320, 390]) for (const theme of ["light", "dark"]) for (const signedIn of [true, false]) {
          const label = `${engine}-${width}-${theme}-${signedIn ? "signed-in" : "signed-out"}`
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, colorScheme: theme, isMobile: width < 500, hasTouch: width < 500, serviceWorkers: "block" })
          const errors = [], unexpected = []
          await context.route("**/*", async route => {
            const request = route.request(), url = new URL(request.url()), method = request.method()
            const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) })
            if (url.origin !== origin) return route.abort("blockedbyclient")
            if (url.pathname === "/api/admin/session" && method === "GET") return json(signedIn
              ? { authenticated: true, resetRequired: false, username: "synthetic@example.invalid", displayName: "Synthetic Viewer", role: "USER", permissions: { "email-templates": "edit" } }
              : { authenticated: false, resetRequired: false, username: null, displayName: null, role: null, permissions: {} })
            if (url.pathname === "/api/admin/email-templates" && method === "GET") {
              const id = url.searchParams.get("id")
              if (id) return json({ template: templates.find(row => row.id === id) || null })
              if (url.searchParams.get("mode") === "recipients") return json({ contacts: [], groups: [] })
              return json({ templates, lastImportedAt: null, lastUpdatedAt: null, revision: "a".repeat(64) })
            }
            if (url.pathname.startsWith("/api/")) { unexpected.push({ method, path: url.pathname }); return json({ message: "Blocked synthetic API" }, 403) }
            if (method === "GET" && ["/_vercel/insights/script.js", "/_vercel/speed-insights/script.js"].includes(url.pathname)) return route.fulfill({ contentType: "application/javascript", body: "/* Synthetic telemetry: no transmission. */" })
            if (!["GET", "HEAD"].includes(method)) { unexpected.push({ method, path: url.pathname }); return route.abort("blockedbyclient") }
            const response = await fetch(local + url.pathname + url.search, { redirect: "manual" })
            const headers = Object.fromEntries(response.headers)
            for (const key of ["content-encoding", "transfer-encoding", "content-length"]) delete headers[key]
            return route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) })
          })
          const page = await context.newPage(); page.setDefaultTimeout(12000)
          page.on("pageerror", error => errors.push(error.message))
          page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
          page.on("console", message => { if (message.type() === "error" && !/Content Security Policy.*report-only/i.test(message.text())) errors.push(message.text()) })
          const response = await page.goto(`${origin}/admin/outlooktemplates`, { waitUntil: "networkidle" })
          assert.equal(response.status(), 200)
          if (signedIn) {
            await page.getByRole("button", { name: "Synthetic A", exact: true }).click()
            await page.locator('input[value="Synthetic A"]').waitFor()
          } else {
            await page.getByRole("heading", { name: "Access Denied", exact: true }).waitFor()
            assert.equal(await page.getByRole("button", { name: "Delete", exact: true }).count(), 0)
          }
          const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, dark: matchMedia("(prefers-color-scheme: dark)").matches }))
          assert.ok(metrics.documentWidth <= width + 1, `horizontal overflow ${JSON.stringify(metrics)}`)
          assert.deepEqual(unexpected, [])
          assert.deepEqual(errors, [])
          const screenshot = path.join(out, `${label}.png`)
          await page.screenshot({ path: screenshot, fullPage: true })
          cases.push({ label, result: "PASS", metrics, screenshot })
          await context.close()
        }
      } finally { await browser.close() }
    }
  } finally { server.kill("SIGTERM") }
  console.log(JSON.stringify({ buildId: require("fs").readFileSync(path.join(root, ".next/BUILD_ID"), "utf8").trim(), output: out, cases }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
