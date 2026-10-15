// Actual alert HTML, synthetic data, dedicated headless Chromium/WebKit.
// No SMTP, database, signed-in browser or live network calls.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { transformSync } = require("esbuild")
const { chromium, webkit } = require("playwright")
const root = path.resolve(__dirname, "..")
function load(relative, modules = {}) {
  const loaded = { exports: {} }
  const code = transformSync(fs.readFileSync(path.join(root, relative), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", code)(name => { assert.ok(name in modules, name); return modules[name] }, loaded, loaded.exports)
  return loaded.exports
}
async function main() {
  const config = load("config/fcunoConnections.ts")
  const { buildHealthAlertHtml } = load("lib/systemHealthAlerts.ts", { "@/config/fcunoConnections": config })
  const checkedAt = "2026-10-15T00:30:00.000Z"
  const email = buildHealthAlertHtml([
    { id: "backup", label: "Database backup", status: "warning", checkedAt,
      message: "The overnight database backup is missing or older than expected.",
      details: { lastSuccessfulBackupAt: "2026-10-13T19:10:00Z", action: "Open System Health and arrange a verified database backup." } },
    { id: "drive-file-content-backup", label: "File backups", status: "error", checkedAt,
      message: "5 files are still missing a verified backup after the backup deadline.",
      details: { lastSuccessfulBackupAt: "2026-10-14T18:10:00Z", missingFiles: 5,
        missingFileNames: `${"Long_filename_".repeat(12)}.png; Port map.pdf; Notice.txt; Fourth.pdf; Fifth.pdf`,
        action: "Open System Health and arrange a verified backup of the missing files." } },
  ], checkedAt)
  const screenshots = process.env.FCUNO_BACKUP_EMAIL_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "fcuno-backup-email-"))
  fs.mkdirSync(screenshots, { recursive: true })
  const cases = []
  for (const [engine, launcher] of [["chromium", chromium], ["webkit", webkit]]) {
    const browser = await launcher.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    try {
      for (const width of [320, 390, 1440]) for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme })
        try {
          await context.route("**/*", route => { throw new Error(`No network is allowed: ${route.request().url()}`) })
          const page = await context.newPage()
          await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><style>body{margin:0;padding:8px;background:${colorScheme === "dark" ? "#101820" : "#eef3f7"}}</style></head><body>${email}</body></html>`)
          const result = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth,
            text: document.body.innerText,
            link: document.querySelector("a").getAttribute("href"),
            foreground: getComputedStyle(document.body.firstElementChild).color,
            background: getComputedStyle(document.body.firstElementChild).backgroundColor,
          }))
          assert.equal(result.overflow, false, `${engine} ${width} ${colorScheme} horizontal overflow`)
          assert.match(result.text, /Last verified backup/)
          assert.match(result.text, /and 2 more/)
          assert.doesNotMatch(result.text, /Fourth|Fifth|artifactSha256|generation|ERROR|WARNING/)
          assert.equal(result.link, "https://fcuno.com/admin/systemhealth")
          assert.equal(result.foreground, "rgb(16, 36, 58)")
          assert.equal(result.background, "rgb(255, 255, 255)")
          const screenshot = path.join(screenshots, `${engine}-${width}-${colorScheme}.png`)
          await page.screenshot({ path: screenshot, fullPage: true })
          cases.push({ engine, width, colorScheme, screenshot, passed: true })
        } finally { await context.close() }
      }
    } finally { await browser.close() }
  }
  console.log(JSON.stringify({ cases: cases.length, passed: cases.length, screenshots, limitations: "HTML browser rendering only; native Outlook automatic dark-mode transformation is not simulated. Email has no signed-in/signed-out UI." }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
