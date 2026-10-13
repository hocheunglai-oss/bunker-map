/* Actual session providers, navigation and Supabase transport; synthetic HTTP only.
 * A dedicated headless browser is created and closed. No personal profile is used.
 * --baseline-ref=<full SHA> bundles the immutable release's runtime files in memory.
 */
const assert = require("node:assert/strict")
const http = require("node:http")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { build } = require("esbuild")
const root = path.resolve(__dirname, "..")
const baseline = process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.split("=")[1]
if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error("Use an immutable full baseline SHA")

async function main() {
  const runtimeFiles = /\/(?:lib\/(?:useSimpleAdminAuth|useSpcAuth|supabase)\.ts|components\/(?:AdminNavigationShell|SpcNavigationShell)\.tsx|app\/admin\/page\.tsx)$/
  const bundle = await build({
    absWorkingDir: root, entryPoints: ["tests/fixtures/client-session-page.tsx"], bundle: true, write: false,
    outdir: "client-session-fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning", loader: { ".png": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://client-session-test.supabase.co"', "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"synthetic-anon-key"' },
    plugins: [{ name: "framework-only-mocks", setup(builder) {
      builder.onResolve({ filter: /^(next\/(navigation|link|image)|@\/components\/(ParserReportSidebarBadge|SpcForcedPasswordChange|SpcMobileModeControl|AdminAiWorkbench))$/ }, ({ path: id }) => ({ path: id, namespace: "framework-mock" }))
      builder.onLoad({ filter: /.*/, namespace: "framework-mock" }, ({ path: id }) => ({ loader: "tsx", resolveDir: root, contents:
        id === "next/navigation" ? `export const usePathname=()=>window.location.pathname; export const useRouter=()=>({prefetch(){},push(){},replace(){},refresh(){}});`
          : id === "next/link" ? `import React from "react"; export default function Link({href,children,prefetch,...props}) { return <a href={href} {...props}>{children}</a> }`
          : id === "next/image" ? `import React from "react"; export default function Image({alt}) { return <span role="img" aria-label={alt}/> }`
          : `export const ParserReportSidebarBadge=()=>null; export const SpcForcedPasswordChange=()=>null; export const SpcMobileModeControl=()=>null; export const AdminAiWorkbench=()=>null;`,
      }))
      if (baseline) builder.onLoad({ filter: runtimeFiles }, ({ path: filename }) => ({ contents: execFileSync("git", ["show", `${baseline}:${path.relative(root, filename)}`], { cwd: root, encoding: "utf8" }), loader: filename.endsWith("tsx") ? "tsx" : "ts", resolveDir: path.dirname(filename) }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map((file) => [`/${path.basename(file.path)}`, file.contents]))
  const script = [...assets.keys()].find((name) => name.endsWith(".js"))
  const server = http.createServer((request, response) => {
    const asset = assets.get(new URL(request.url, "http://127.0.0.1").pathname)
    response.setHeader("Content-Type", asset ? "text/javascript" : "text/html")
    response.end(asset || `<!doctype html><html><body><div id="root"></div><script src="${script}"></script></body></html>`)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  let context
  let page
  let requests
  let pageErrors
  let dialogs
  let sessionAuthenticated
  let logoutStatus
  let loginFailure
  const failures = []
  try {
    browser = await require("playwright").chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    async function reset({ mode = "admin", fault = "write", nav = false, authenticated = true, failedLogout = false, failedLogin = "", returnTo = "", viewOnly = false, metadataProbe = false, resetFlag = false } = {}) {
      if (context) await context.close()
      context = await browser.newContext()
      requests = []; pageErrors = []; dialogs = []
      sessionAuthenticated = authenticated; logoutStatus = failedLogout ? 503 : 200
      loginFailure = failedLogin
      await context.addInitScript(({ fault }) => {
        if (fault === "getter") Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError") } })
        else if (fault !== "none") {
          const storage = window.localStorage
          const set = Storage.prototype.setItem
          const remove = Storage.prototype.removeItem
          if (fault === "write" || fault === "all") Storage.prototype.setItem = function (...args) { if (this === storage) throw new DOMException("Storage full", "QuotaExceededError"); return set.apply(this, args) }
          if (fault === "remove" || fault === "all") Storage.prototype.removeItem = function (...args) { if (this === storage) throw new DOMException("Storage unavailable", "SecurityError"); return remove.apply(this, args) }
        }
      }, { fault })
      await context.route("**/*", async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.pathname.startsWith("/api/")) {
          requests.push({ path: url.pathname, method: request.method(), headers: request.headers() })
          let body = {}
          let status = 200
          if (url.pathname.endsWith("/login")) {
            if (loginFailure === "network") return route.abort("connectionreset")
            if (loginFailure === "invalid-json") return route.fulfill({ status: 503, contentType: "text/html", body: "temporarily unavailable" })
            if (loginFailure === "rejected") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Incorrect synthetic password." }) })
            sessionAuthenticated = true
            body = { user: { username: "synthetic-user", role: "ADMIN", permissions: {}, pages: [] } }
          }
          else if (url.pathname.endsWith("/session")) body = { authenticated: sessionAuthenticated, username: sessionAuthenticated ? "synthetic-user" : null, role: viewOnly ? "AC" : "ADMIN", permissions: viewOnly ? { pricesetter: "view" } : {}, pages: [], ...(metadataProbe ? { resetRequired: resetFlag, password: "synthetic-never-cache", accessToken: "synthetic-never-cache", refreshToken: "synthetic-never-cache" } : {}) }
          else if (url.pathname.endsWith("/logout")) { status = logoutStatus; if (status === 200) sessionAuthenticated = false }
          else if (url.pathname === "/api/admin/supabase") body = [{ id: "synthetic-port" }]
          else if (url.pathname === "/api/admin/pages") body = { pages: [] }
          return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
        }
        if (url.origin === origin) return route.continue()
        requests.push({ path: "EXTERNAL:" + request.url(), method: request.method() })
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      })
      page = await context.newPage(); page.setDefaultTimeout(3000)
      page.on("pageerror", (error) => pageErrors.push(error.message))
      page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.accept() })
      await page.goto(`${origin}/${mode.startsWith("admin") ? "admin/pricesetter" : "spc/enquiries"}?mode=${mode}${nav ? "&nav=1" : ""}${returnTo ? "&returnTo=" + encodeURIComponent(returnTo) : ""}`)
      if (mode === "admin-login") await page.getByRole("button", { name: "Login", exact: true }).waitFor()
      else await page.waitForFunction(() => { const element = document.querySelector('[data-testid="auth"]'); return element && element.textContent !== "loading" })
    }
    async function run(name, test) {
      try { await test(); console.log("PASS: " + name) }
      catch (error) { failures.push(name + ": " + error.message); console.error("FAIL: " + name + ": " + error.message) }
    }
    await run("FCUNO valid server session survives full browser storage", async () => {
      await reset()
      assert.equal(await page.getByTestId("auth").textContent(), "signed-in")
      await page.getByRole("button", { name: "Read prices" }).click()
      await page.getByTestId("read").filter({ hasText: "read-ok" }).waitFor()
      const read = requests.find((item) => item.path === "/api/admin/supabase")
      assert.equal(read?.headers["x-bunker-admin-user"], "synthetic-user", "authenticated reads retain proxy/audit context without disk storage")
      assert.equal(requests.some((item) => item.path.startsWith("EXTERNAL:")), false)
      assert.deepEqual(pageErrors, [])
    })
    await run("FCUNO cache stores only literal reset status and selected display metadata", async () => {
      for (const resetFlag of [true, false, "false", "synthetic-never-cache"]) {
        await reset({ fault: "none", metadataProbe: true, resetFlag })
        const raw = await page.evaluate(() => window.localStorage.getItem("bunker_admin_actor"))
        const cached = JSON.parse(raw)
        assert.equal(cached.resetRequired, resetFlag === true)
        assert.equal(typeof cached.resetRequired, "boolean")
        assert.deepEqual(Object.keys(cached).sort(), ["displayName", "pages", "permissions", "resetRequired", "role", "username"])
        assert.equal(raw.includes("synthetic-never-cache"), false)
        assert.deepEqual(pageErrors, [])
      }
    })
    await run("FCUNO sidebar opens and toggles when storage is disabled", async () => {
      await reset({ fault: "getter", nav: true })
      await page.getByRole("button", { name: "Collapse admin navigation", exact: true }).click()
      assert.equal(await page.locator(".fc-admin-app-shell.is-collapsed").count(), 1)
      await page.getByRole("button", { name: "Expand admin navigation", exact: true }).first().click()
      assert.equal(await page.locator(".fc-admin-app-shell.is-collapsed").count(), 0)
      assert.deepEqual(pageErrors, [])
    })
    await run("SPC valid session survives full browser storage", async () => {
      await reset({ mode: "spc" })
      assert.equal(await page.getByTestId("auth").textContent(), "signed-in")
      assert.deepEqual(pageErrors, [])
    })
    await run("View-only access remains read-only when browser cache writes fail", async () => {
      await reset({ viewOnly: true })
      assert.equal(await page.getByTestId("auth").textContent(), "signed-in")
      await page.getByRole("button", { name: "Read prices" }).click()
      await page.getByTestId("read").filter({ hasText: "read-ok" }).waitFor()
      await page.getByRole("button", { name: "Try protected edit" }).click()
      await page.getByTestId("read").filter({ hasText: "edit-blocked" }).waitFor()
      assert.equal(requests.some((item) => item.path === "/api/admin/supabase" && item.method !== "GET"), false)
      assert.equal(requests.some((item) => item.path.startsWith("EXTERNAL:")), false)
      assert.deepEqual(pageErrors, [])
    })
    await run("SPC sidebar remains usable with disabled browser storage", async () => {
      await reset({ mode: "spc", fault: "getter", nav: true })
      await page.getByRole("button", { name: "Collapse SPC navigation", exact: true }).click()
      assert.equal(await page.locator(".fc-admin-app-shell.is-collapsed").count(), 1)
      await page.getByRole("button", { name: "Expand SPC navigation", exact: true }).first().click()
      assert.equal(await page.locator(".fc-admin-app-shell.is-collapsed").count(), 0)
      assert.deepEqual(pageErrors, [])
    })
    await run("SPC login cache publication and clearing survive disabled storage", async () => {
      await reset({ mode: "spc", fault: "getter", authenticated: false })
      await page.getByRole("button", { name: "Prime signed-in session" }).click()
      assert.equal(await page.getByTestId("auth").textContent(), "signed-in")
      await page.getByRole("button", { name: "Clear signed-in session" }).click()
      assert.equal(await page.getByTestId("auth").textContent(), "signed-out")
      assert.deepEqual(pageErrors, [])
    })
    await run("FCUNO logout reaches server even when removal from storage fails", async () => {
      await reset({ fault: "remove", nav: true })
      await page.getByRole("button", { name: "Logout", exact: true }).click()
      await page.waitForURL(`${origin}/admin`)
      assert.equal(requests.filter((item) => item.path === "/api/admin/logout").length, 1)
      assert.equal(sessionAuthenticated, false)
      assert.deepEqual(pageErrors, [])
    })
    await run("SPC failed server logout preserves session and offers retry", async () => {
      await reset({ mode: "spc", nav: true, fault: "none", failedLogout: true })
      const before = page.url()
      await page.getByRole("button", { name: "Logout", exact: true }).click()
      await page.waitForTimeout(100)
      assert.equal(page.url(), before)
      assert.equal(await page.getByTestId("auth").textContent(), "signed-in")
      assert.match(dialogs.join(" "), /try again|retry/i)
      logoutStatus = 200
      await page.getByRole("button", { name: "Logout", exact: true }).click()
      await page.waitForURL(`${origin}/spc`)
      assert.equal(sessionAuthenticated, false)
      assert.deepEqual(pageErrors, [])
    })
    for (const failure of ["network", "invalid-json", "rejected"]) await run(`Actual FCUNO login recovers after ${failure} response`, async () => {
      await reset({ mode: "admin-login", authenticated: false, failedLogin: failure })
      await page.getByLabel("Username", { exact: true }).fill("synthetic-user")
      await page.getByLabel("Password", { exact: true }).fill("synthetic-only-password")
      await page.getByRole("button", { name: "Login", exact: true }).click()
      await page.getByText(failure === "rejected" ? "Incorrect synthetic password." : "Unable to sign in. Please try again.", { exact: true }).waitFor()
      assert.equal(await page.getByRole("button", { name: "Login", exact: true }).isEnabled(), true)
      assert.deepEqual(pageErrors, [])
    })
    await run("Actual FCUNO login continues after acknowledged login with disabled storage", async () => {
      const target = "/api/oidc/authorize?client_id=synthetic-only"
      await reset({ mode: "admin-login", authenticated: false, fault: "getter", returnTo: target })
      await page.getByLabel("Username", { exact: true }).fill("synthetic-user")
      await page.getByLabel("Password", { exact: true }).fill("synthetic-only-password")
      await page.getByRole("button", { name: "Login", exact: true }).click()
      await page.waitForURL(origin + target)
      assert.equal(sessionAuthenticated, true)
      assert.deepEqual(pageErrors, [])
    })
    if (failures.length) throw new Error(`${failures.length} regression group(s) failed\n${failures.join("\n")}`)
    console.log("All session/storage tests stayed in synthetic HTTP and isolated headless contexts.")
  } finally {
    if (context) await context.close()
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
