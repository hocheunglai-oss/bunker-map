/* Actual CCINFO React page, isolated synthetic APIs, Chromium + WebKit.
 * No personal browser, credentials, live data, or external requests are used.
 * NODE_PATH must include a Playwright installation when it is not local.
 */
const assert = require("node:assert/strict")
const { mkdtempSync, readFileSync } = require("node:fs")
const { join, resolve, basename } = require("node:path")
const http = require("node:http")
const { build } = require("esbuild")
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright")
const root = resolve(__dirname, "..")
const firstId = "11111111-1111-4111-8111-111111111111"
const secondId = "22222222-2222-4222-8222-222222222222"
const version = "2026-10-14T01:00:00.123456Z"
const output = mkdtempSync("/private/tmp/fcuno-ccinfo-file-ui-")
const fullPath = folder => [folder.folder_path, folder.name].filter(Boolean).join("/")
const within = (path, parent) => path === parent || path.startsWith(`${parent}/`)

async function main() {
  const bundle = await build({
    absWorkingDir: root, stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import Page from "./app/admin/ccinfo/page"; createRoot(document.getElementById("root")).render(<Page/>);', resolveDir: root, sourcefile: "ccinfo-files-fixture.tsx", loader: "tsx" },
    bundle: true, write: false, outdir: "fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
    define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "isolated-page-dependencies", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/(supabase|useSimpleAdminAuth|useIsMobile)$/ }, args => ({ path: args.path, namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ resolveDir: root, contents: args.path.endsWith("/supabase")
        ? 'import {createClient} from "@supabase/supabase-js"; export const supabase=createClient(location.origin,"synthetic-local-only",{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});'
        : args.path.endsWith("/useIsMobile") ? "export const useIsMobile=()=>innerWidth<768;"
          : 'export const useSimpleAdminAuth=()=>({loading:false,authenticated:!new URL(location.href).searchParams.has("signedout")});' }))
    } }],
  })
  const assets = new Map(bundle.outputFiles.map(file => [`/${basename(file.path)}`, file.contents]))
  const js = [...assets.keys()].find(name => name.endsWith(".js")), css = [...assets.keys()].find(name => name.endsWith(".css"))
  const globals = readFileSync(join(root, "app/globals.css"), "utf8").replace('@import "tailwindcss";', "")
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/globals.css">${css ? `<link rel="stylesheet" href="${css}">` : ""}<style>*{box-sizing:border-box}body{margin:0;--font-roboto:Arial}button,input{font:inherit}</style></head><body class="fc-admin-scope"><div id="root"></div><script src="${js}"></script></body></html>`
  let companies, folders, manualFiles, importedFiles, holdUpload, releaseUpload, renameCount
  function reset() {
    companies = [{ id: firstId, name: "FIRST SYNTHETIC COMPANY", notes: "FIRST SYNTHETIC NOTE", summary: null, updated_at: version }, { id: secondId, name: "SECOND SYNTHETIC COMPANY", notes: "SECOND SYNTHETIC NOTE", summary: null, updated_at: version }]
    folders = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", entry_kind: "company", entry_id: firstId, folder_path: "", name: "A", updated_at: version, implicit: false }, { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", entry_kind: "company", entry_id: firstId, folder_path: "A", name: "EMPTY CHILD", updated_at: version, implicit: false }, { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", entry_kind: "company", entry_id: firstId, folder_path: "A/EMPTY CHILD", name: "DEEP EMPTY", updated_at: version, implicit: false }, { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", entry_kind: "company", entry_id: firstId, folder_path: "", name: "DESTINATION", updated_at: version, implicit: false }]
    manualFiles = [{ id: "manual-a", entry_kind: "company", entry_id: firstId, folder_path: "A", file_name: "manual.txt", file_type: "TXT", drive_file_id: "synthetic-manual", drive_url: "https://synthetic.invalid/manual", deleted_at: null }, { id: "manual-mix", entry_kind: "company", entry_id: firstId, folder_path: "MIX%,_", file_name: "manual-mixed.txt", file_type: "TXT", drive_file_id: "synthetic-mixed", drive_url: "https://synthetic.invalid/mixed", deleted_at: null }, { id: "second-only", entry_kind: "company", entry_id: secondId, folder_path: "", file_name: "second-only.txt", file_type: "TXT", drive_file_id: "synthetic-second", drive_url: "https://synthetic.invalid/second", deleted_at: null }]
    importedFiles = [{ id: "imported-mix", company_id: firstId, file_name: "imported-mixed.txt", file_type: "TXT", original_path: "company/FIRST SYNTHETIC COMPANY/MIX%,_/imported-mixed.txt", drive_file_id: "synthetic-imported", drive_url: "https://synthetic.invalid/imported", deleted_at: null }]
    holdUpload = false; releaseUpload = null; renameCount = 0
  }
  reset()
  const json = (response, value, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value))
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1")
      response.setHeader("Cache-Control", "no-store")
      if (url.pathname.startsWith("/rest/v1/")) {
        const table = url.pathname.slice("/rest/v1/".length)
        let rows = table === "cc_companies" ? companies : table === "cc_entry_folders" ? folders : table === "cc_entry_files" ? manualFiles : table === "cc_company_files" ? importedFiles : []
        rows = rows.filter(row => [...url.searchParams].every(([key, value]) => !value.startsWith("eq.") || row[key] === value.slice(3)))
        const deleted = url.searchParams.get("deleted_at")
        if (deleted) rows = rows.filter(row => deleted === "is.null" ? !row.deleted_at : !!row.deleted_at)
        const needle = url.searchParams.get("name")
        if (needle?.startsWith("ilike.")) rows = rows.filter(row => row.name.toLowerCase().includes(needle.slice(6).replaceAll("%", "").toLowerCase()))
        return json(response, request.headers.accept?.includes("application/vnd.pgrst.object+json") ? rows[0] || null : rows)
      }
      if (url.pathname === "/api/admin/audit-logs") return json(response, { logs: [] })
      if (url.pathname === "/api/ccinfo/files") {
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
        if (["renameFolder", "moveFolder"].includes(body.action)) {
          const source = folders.find(folder => folder.id === body.folderId)
          assert.equal(body.expectedUpdatedAt, source.updated_at)
          const previousPath = body.folderPath, nextPath = body.action === "renameFolder" ? [source.folder_path, body.name].filter(Boolean).join("/") : [body.targetFolderPath, source.name].filter(Boolean).join("/")
          const changedFolders = []
          folders = folders.map(folder => {
            const path = fullPath(folder)
            if (!within(path, previousPath)) return folder
            const next = `${nextPath}${path.slice(previousPath.length)}`.split("/")
            const result = { ...folder, name: next.pop(), folder_path: next.join("/"), updated_at: "2026-10-14T02:00:00.123456Z" }
            changedFolders.push(result); return result
          })
          const changedFiles = []
          manualFiles = manualFiles.map(file => {
            if (file.entry_id !== firstId || !within(file.folder_path, previousPath)) return file
            const changed = { ...file, folder_path: `${nextPath}${file.folder_path.slice(previousPath.length)}`, original_path: `company/FIRST SYNTHETIC COMPANY/${nextPath}/${file.file_name}` }
            changedFiles.push({ id: changed.id, folder_path: changed.folder_path, original_path: changed.original_path }); return changed
          })
          renameCount += body.action === "renameFolder" ? 1 : 0
          return json(response, { ok: true, [body.action === "renameFolder" ? "rename" : "move"]: { entryKind: "company", entryId: firstId, previousPath, folderPath: nextPath, folders: changedFolders, entryFiles: changedFiles, companyFiles: [] } })
        }
        if (body.action === "deleteFolderContents") {
          const entryFileIds = manualFiles.filter(file => file.entry_id === firstId && within(file.folder_path, body.folderPath)).map(file => file.id)
          const companyFileIds = importedFiles.filter(file => file.company_id === firstId && file.original_path.includes(`/${body.folderPath}/`)).map(file => file.id)
          const deletedAt = "2026-10-14T03:00:00.000Z"
          manualFiles = manualFiles.map(file => entryFileIds.includes(file.id) ? { ...file, deleted_at: deletedAt } : file)
          importedFiles = importedFiles.map(file => companyFileIds.includes(file.id) ? { ...file, deleted_at: deletedAt } : file)
          return json(response, { ok: true, deletion: { entryKind: "company", entryId: firstId, folderPath: body.folderPath, folderIds: [], entryFileIds, companyFileIds, deletedAt } })
        }
        return json(response, { message: "Unexpected synthetic action" }, 400)
      }
      if (url.pathname === "/api/ccinfo/upload") {
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        const form = await new Request("https://synthetic.invalid/upload", { method: "POST", headers: request.headers, body: Buffer.concat(chunks) }).formData()
        if (holdUpload) await new Promise(resolve => { releaseUpload = resolve })
        const file = { id: "held-upload", entry_kind: "company", entry_id: String(form.get("entryId")), folder_path: String(form.get("folderPath")), file_name: form.get("file").name, file_type: "TXT", drive_file_id: "synthetic-upload", drive_url: "https://synthetic.invalid/upload", deleted_at: null }
        manualFiles.push(file)
        return json(response, { file: { ...file, source: "entry" } })
      }
      if (url.pathname === "/globals.css") return response.writeHead(200, { "content-type": "text/css" }).end(globals)
      const asset = assets.get(url.pathname)
      response.writeHead(200, { "content-type": asset ? url.pathname.endsWith(".css") ? "text/css" : "text/javascript" : "text/html" }).end(asset || html)
    } catch (error) { json(response, { message: error.message }, 500) }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const results = []
  try {
    for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await engine.launch({ headless: true })
      try {
        for (const width of [320, 390, 1440]) for (const mode of ["light", "dark"]) {
          reset()
          const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: mode })
          await context.route("**/*", route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort())
          const page = await context.newPage(), errors = []
          page.setDefaultTimeout(10000)
          page.on("pageerror", error => errors.push(error.message))
          page.on("dialog", dialog => dialog.accept())
          await page.goto(`${origin}/admin/ccinfo?kind=company&id=${firstId}`)
          await page.getByText("FIRST SYNTHETIC NOTE", { exact: true }).waitFor()
          const row = path => page.locator(`[data-ccinfo-folder-row=${JSON.stringify(path)}]`)
          await row("A").getByRole("button", { name: "Edit", exact: true }).click()
          await page.getByLabel("Name", { exact: true }).fill("RENAMED")
          await page.screenshot({ path: join(output, `${engineName}-${width}-${mode}-editor.png`), fullPage: true })
          await page.getByRole("button", { name: "Rename", exact: true }).click()
          await row("RENAMED").waitFor()
          assert.equal(await row("A").count(), 0)
          await row("RENAMED").click()
          await row("RENAMED/EMPTY CHILD").waitFor()
          await row("RENAMED/EMPTY CHILD").click()
          await row("RENAMED/EMPTY CHILD/DEEP EMPTY").waitFor()
          await page.getByRole("button", { name: "HOME", exact: true }).click()
          await row("MIX%,_").getByRole("button", { name: "Edit", exact: true }).click()
          await page.getByRole("button", { name: "Delete", exact: true }).click()
          await page.getByText("Folder contents moved to Recently Deleted.", { exact: true }).waitFor()
          assert.equal(await row("MIX%,_").count(), 0)
          assert.ok(manualFiles.find(file => file.id === "manual-mix").deleted_at)
          assert.ok(importedFiles[0].deleted_at)
          await page.screenshot({ path: join(output, `${engineName}-${width}-${mode}-files.png`), fullPage: true })
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
          assert.equal(overflow, false, `${engineName} ${width} ${mode} horizontal overflow`)
          holdUpload = true
          await row("RENAMED").click()
          await page.locator('input[type="file"]').setInputFiles({ name: "held-upload.txt", mimeType: "text/plain", buffer: Buffer.from("SYNTHETIC ONLY") })
          await page.waitForFunction(() => document.body.textContent.includes("Uploading..."))
          await page.getByRole("button", { name: "HOME", exact: true }).click()
          await row("RENAMED").getByRole("button", { name: "Edit", exact: true }).click()
          await page.getByLabel("Name", { exact: true }).fill("SHOULD NOT RUN")
          await page.getByRole("button", { name: "Rename", exact: true }).click()
          await page.getByText(/Please wait for the current file change/).waitFor()
          assert.equal(renameCount, 1)
          await page.getByRole("button", { name: "Cancel", exact: true }).click()
          await page.getByPlaceholder(width < 768 ? "Search..." : "Search company, country or port...").fill("SECOND")
          await page.getByText("SECOND SYNTHETIC COMPANY", { exact: true }).click()
          await page.getByText("SECOND SYNTHETIC NOTE", { exact: true }).waitFor()
          assert.ok(releaseUpload)
          releaseUpload()
          await page.waitForResponse(response => response.url().endsWith("/api/ccinfo/upload"))
          await page.waitForTimeout(50)
          assert.equal(await page.locator('[data-ccinfo-file-row="held-upload"]').count(), 0)
          assert.equal(await page.locator('[data-ccinfo-file-row="second-only"]').count(), 1)
          await page.goto(`${origin}/admin/ccinfo?kind=company&id=${firstId}`)
          await row("RENAMED").waitFor()
          await row("DESTINATION").scrollIntoViewIfNeeded()
          const transfer = await page.evaluateHandle(() => new DataTransfer())
          const inactiveOutline = await row("DESTINATION").evaluate(node => getComputedStyle(node).outlineColor)
          await row("RENAMED").dispatchEvent("dragstart", { dataTransfer: transfer })
          const bounds = await row("DESTINATION").boundingBox()
          const event = { dataTransfer: transfer, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 }
          await row("DESTINATION").dispatchEvent("dragover", event)
          assert.equal(await row("DESTINATION").evaluate(node => getComputedStyle(node).outlineWidth), "2px", "insertion destination must be highlighted before drop")
          assert.notEqual(await row("DESTINATION").evaluate(node => getComputedStyle(node).outlineColor), inactiveOutline, "drop indicator must visibly change the exact destination")
          await page.screenshot({ path: join(output, `${engineName}-${width}-${mode}-drop-indicator.png`), fullPage: true })
          await row("DESTINATION").dispatchEvent("drop", event)
          await row("RENAMED").waitFor({ state: "detached" })
          await row("DESTINATION").click()
          await row("DESTINATION/RENAMED").waitFor()
          await row("DESTINATION/RENAMED").click()
          await row("DESTINATION/RENAMED/EMPTY CHILD").waitFor()
          await page.goto(`${origin}/admin/ccinfo?kind=company&id=${firstId}&signedout=1`)
          await page.getByText("Access Denied", { exact: true }).waitFor()
          assert.equal(await page.getByRole("button", { name: "Upload File", exact: true }).count(), 0)
          await page.screenshot({ path: join(output, `${engineName}-${width}-${mode}-signedout.png`), fullPage: true })
          assert.deepEqual(errors, [])
          results.push({ engine: engineName, width, mode, passed: true })
          await context.close()
        }
      } finally { await browser.close() }
    }
    console.log(JSON.stringify({ output, results }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
