/* Actual China client/global CSS/assets; synthetic read-only report payload.
 * Dedicated headless Chromium + WebKit only. No auth, database or live calls.
 * NODE_PATH=<bundled modules> PLAYWRIGHT_BROWSERS_PATH=<owned browsers>
 * CHROME_EXECUTABLE_PATH=<Chrome> node tests/china-report-scroll.browser.test.cjs
 * --baseline proves the released client clips the last price before this fix.
 */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const http = require("node:http")
const crypto = require("node:crypto")
const { build } = require("esbuild")
const postcss = require("postcss")
const tailwind = require("@tailwindcss/postcss")
const { chromium, webkit } = require("playwright")

const root = path.resolve(__dirname, "..")
const clientPath = "app/reports/china/ChinaReportClient.tsx"
const baselineCommit = "73124c75d0e7389107518d4e9bd01ee49eea2e46"
// Exact released client from the pinned commit above. Keep the immutable hash so
// shallow CI checkouts can prove the old behavior without Git history or network.
const baselineSha256 = "3acecc4c0d4308e7d8833711d82eae97bec1bc433201aed9138fa9afb7214e03"
const oldClient = fs.readFileSync(path.join(root, "tests/fixtures/china-report-scroll-baseline.tsx"), "utf8")
assert.equal(crypto.createHash("sha256").update(oldClient).digest("hex"), baselineSha256, "released baseline fixture must remain byte-exact")
const baselineOnly = process.argv.includes("--baseline")
const screenshots = process.env.CHINA_REPORT_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "fcuno-china-scroll-"))
const payload = {
  key: "china", unavailable: false, fallbacks: { "fangcheng::hsfo": "NA" },
  snapshot: { reportDate: "12 Oct 2026", sections: [
    { title: "CHINA (EAST)", rows: [
      { port: "Zhoushan", hsfo: 0, vlsfo: 930, mgo: 1379.25 },
      { port: "Shanghai", hsfo: 865, vlsfo: 935, mgo: 1380 },
      { port: "Qingdao", hsfo: 860, vlsfo: 945, mgo: 1390.5 },
    ] },
    { title: "CHINA (NORTH)", rows: [
      { port: "Dalian", hsfo: 925, vlsfo: 985, mgo: 1400 },
      { port: "Tianjin", hsfo: 915, vlsfo: 980, mgo: 1410 },
      { port: "Bayuquan", hsfo: 920, vlsfo: 990, mgo: 1420 },
    ] },
    { title: "CHINA (SOUTH)", rows: [
      { port: "Guangzhou", hsfo: 880, vlsfo: 970, mgo: 1430 },
      { port: "Fangcheng", hsfo: null, vlsfo: 1010, mgo: 1440 },
      { port: "Nansha", hsfo: 890, vlsfo: 975, mgo: 1450 },
    ] },
    { title: "HONG KONG / SINGAPORE", rows: [
      { port: "Hong Kong", hsfo: 955, vlsfo: 965, mgo: 1240 },
      { port: "Singapore", hsfo: 840, vlsfo: 870, mgo: 1250 },
    ] },
    { title: "TAIWAN", rows: [{ port: "Kaohsiung", hsfo: null, vlsfo: 985, mgo: 1460 }] },
    { title: "SOUTH KOREA", rows: [{ port: "Busan", hsfo: 840, vlsfo: 985, mgo: 1350 }] },
  ] },
}
const digest = value => crypto.createHash("sha256").update(value).digest("hex")
const originalPayload = JSON.stringify(payload)

async function main() {
  fs.mkdirSync(screenshots, { recursive: true })
  const bundles = {}
  for (const baseline of [false, true]) {
    const result = await build({
      absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", logLevel: "warning",
      define: { "process.env.NODE_ENV": '"development"' },
      stdin: { contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import Report from "@/app/reports/china/ChinaReportClient"; createRoot(document.getElementById("root")).render(<Report initialData={window.fixturePayload} />);', loader: "tsx", resolveDir: root },
      plugins: [{ name: "owned-readonly-china-fixture", setup(builder) {
        builder.onResolve({ filter: /^next\/(image|link)$/ }, args => ({ path: args.path, namespace: "next-render-boundary" }))
        builder.onLoad({ filter: /.*/, namespace: "next-render-boundary" }, args => ({ loader: "tsx", resolveDir: root,
          contents: args.path === "next/image"
            ? 'import React from "react"; export default function Image({ priority, ...props }) { return <img {...props} /> }'
            : 'import React from "react"; export default function Link(props) { return <a {...props} /> }',
        }))
        if (baseline) builder.onLoad({ filter: /ChinaReportClient\.tsx$/ }, () => ({ contents: oldClient, loader: "tsx", resolveDir: path.join(root, "app/reports/china") }))
      } }],
    })
    bundles[baseline ? "/baseline.js" : "/current.js"] = result.outputFiles[0].contents
  }
  const styles = await postcss([tailwind({ base: root })]).process(fs.readFileSync(path.join(root, "app/globals.css"), "utf8"), { from: path.join(root, "app/globals.css") })
  let apiReads = 0
  const requests = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1")
    requests.push({ path: url.pathname, method: request.method })
    assert.equal(request.method, "GET", "verification must never write")
    response.setHeader("Cache-Control", "no-store")
    if (bundles[url.pathname]) { response.setHeader("Content-Type", "text/javascript"); response.end(bundles[url.pathname]); return }
    if (url.pathname === "/styles.css") { response.setHeader("Content-Type", "text/css"); response.end(styles.css); return }
    if (url.pathname === "/logo-trans.png") { response.setHeader("Content-Type", "image/png"); response.end(fs.readFileSync(path.join(root, "public/logo-trans.png"))); return }
    if (url.pathname === "/api/reports/china") { apiReads++; response.setHeader("Content-Type", "application/json"); response.end(originalPayload); return }
    if (!["/china", "/baseline"].includes(url.pathname)) { response.writeHead(404).end(); return }
    const script = url.pathname === "/baseline" ? "/baseline.js" : "/current.js"
    response.setHeader("Content-Type", "text/html")
    response.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script>window.fixturePayload=${originalPayload}</script><script src="${script}"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, verified = [], browsers = []
  const failures = [], externalRequests = []
  const loaded = async page => {
    await page.getByText("Report Date: 12 Oct 2026", { exact: true }).waitFor()
    await page.locator('img[alt="Bunker map logo"]').evaluate(image => image.decode())
    await page.waitForTimeout(250) // Actual mobile hook also resets scroll at180ms.
  }
  const overflow = async page => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  const geometry = async region => region.evaluate(node => {
    const bounds = node.getBoundingClientRect(), grids = [...node.firstElementChild.children]
    const sectionHeader = node.parentElement.firstElementChild.getBoundingClientRect()
    return { left: bounds.left, right: bounds.right, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, scrollLeft: node.scrollLeft,
      sectionHeaderLeft: sectionHeader.left, sectionHeaderRight: sectionHeader.right,
      touchAction: getComputedStyle(node).touchAction,
      grids: grids.map(grid => [...grid.children].map(cell => { const r = cell.getBoundingClientRect(); return { left: r.left, right: r.right, text: cell.textContent } })) }
  })
  const assertLastPricesReachable = async region => {
    const result = await region.evaluate(node => {
      const bounds = node.getBoundingClientRect()
      return [...node.firstElementChild.children].map(grid => {
        const cell = grid.lastElementChild, range = document.createRange(); range.selectNodeContents(cell)
        const text = range.getBoundingClientRect()
        return { value: cell.textContent, left: text.left, right: text.right, visibleLeft: bounds.left, visibleRight: bounds.right }
      })
    })
    for (const value of result) assert.ok(value.left >= value.visibleLeft - 1 && value.right <= value.visibleRight + 1, `full LSMGO label/value reachable: ${JSON.stringify(value)}`)
  }
  try {
    for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]]) {
      const browser = await type.launch({ headless: true, ...(engine === "chromium" && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
      browsers.push(browser)
      for (const width of [320, 390, 900, 1280]) for (const colorScheme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, hasTouch: width < 500 })
        await context.route("**/*", route => route.request().url().startsWith(`${origin}/`) ? route.continue() : (externalRequests.push(route.request().url()), route.abort()))
        const page = await context.newPage(); page.setDefaultTimeout(8000); page.on("pageerror", error => failures.push(error.message))
        try {
          await page.goto(`${origin}/${baselineOnly ? "baseline" : "china"}`); await loaded(page)
          if (baselineOnly) {
            const clipped = await page.getByText("1379.25", { exact: true }).evaluate(node => {
              const range = document.createRange(); range.selectNodeContents(node); const text = range.getBoundingClientRect()
              let parent = node.parentElement
              while (parent && getComputedStyle(parent).overflowX !== "hidden") parent = parent.parentElement
              return { textRight: text.right, clippedByRight: parent?.getBoundingClientRect().right, ancestorOverflowX: parent && getComputedStyle(parent).overflowX }
            })
            await page.screenshot({ path: path.join(screenshots, `${engine}-${width}-${colorScheme}-baseline.png`), fullPage: true })
            assert.ok(clipped.textRight <= clipped.clippedByRight, `released baseline clips LSMGO: ${JSON.stringify(clipped)}`)
            // A red proof must fail on the measured defect, not unconditionally.
            // If a later pinned baseline is healthy, this probe should succeed.
            console.log("PASS narrow baseline: the final price is not clipped")
            return
          }
          assert.ok(await overflow(page) <= 1, "no horizontal document overflow")
          const regions = page.getByRole("region", { name: /fuel prices$/ }); assert.equal(await regions.count(), 6)
          const east = page.getByRole("region", { name: "CHINA (EAST) fuel prices", exact: true })
          const before = await geometry(east)
          assert.equal(await east.getAttribute("tabindex"), "0")
          assert.equal(before.touchAction, "auto", "horizontal access must not disable vertical touch scrolling")
          for (const grid of before.grids) for (let i = 0; i < 4; i++) assert.ok(Math.abs(grid[i].left - before.grids[0][i].left) <= 1, "header and every row share column positions")
          if (width === 320 || width === 900) assert.ok(before.scrollWidth > before.clientWidth, "narrow/mobile and two-column tablet grid scrolls internally")
          const originalImage = await page.screenshot({ path: path.join(screenshots, `${engine}-${width}-${colorScheme}-left.png`), fullPage: true })
          await east.scrollIntoViewIfNeeded(); await east.focus()
          let nativeTouchTested = false
          if (before.scrollWidth > before.clientWidth) {
            await page.keyboard.press("ArrowRight")
            await page.waitForFunction(() => document.activeElement.scrollLeft > 0)
            await page.keyboard.press("End"); await assertLastPricesReachable(east)
            await page.keyboard.press("Home"); assert.equal((await geometry(east)).scrollLeft, 0)
            if (engine === "chromium" && width < 500) {
              const touch = await context.newCDPSession(page), box = await east.boundingBox()
              const x = box.x + box.width - 20, y = box.y + 16
              try {
                await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] })
                for (let step = 1; step <= 5; step++) {
                  await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - step * 20, y, id: 1 }] })
                  await page.waitForTimeout(20)
                }
                await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
                await page.waitForFunction(() => document.querySelector('[aria-label="CHINA (EAST) fuel prices"]').scrollLeft > 0)
                nativeTouchTested = true
              } finally { await touch.detach() }
              await east.focus(); await page.keyboard.press("Home")
            }
            await east.hover({ position: { x: before.clientWidth / 2, y: 16 } }); await page.mouse.wheel(1000, 0)
            try {
              await page.waitForFunction(() => { const node = document.querySelector('[aria-label="CHINA (EAST) fuel prices"]'); return node.scrollLeft >= node.scrollWidth - node.clientWidth - 1 })
            } catch (error) {
              throw new Error(`${engine} ${width} native horizontal wheel failed: ${JSON.stringify(await geometry(east))}`, { cause: error })
            }
          }
          await assertLastPricesReachable(east)
          const after = await geometry(east)
          assert.equal(after.sectionHeaderLeft, before.sectionHeaderLeft)
          assert.equal(after.sectionHeaderRight, before.sectionHeaderRight, "section title/expansion control remain outside the price scroller")
          await page.screenshot({ path: path.join(screenshots, `${engine}-${width}-${colorScheme}-right.png`), fullPage: true })
          for (let i = 0; i < await regions.count(); i++) {
            const region = regions.nth(i); await region.evaluate(node => { node.scrollLeft = node.scrollWidth })
            await assertLastPricesReachable(region)
          }
          for (const [title, extraPort] of [["CHINA (EAST)", "Qingdao"], ["CHINA (NORTH)", "Bayuquan"], ["CHINA (SOUTH)", "Nansha"]]) {
            const region = page.getByRole("region", { name: `${title} fuel prices`, exact: true })
            const expand = page.getByRole("button", { name: `Expand ${title}`, exact: true })
            assert.equal(await region.getByText(extraPort, { exact: true }).count(), 0)
            await expand.click(); assert.equal(await page.getByRole("button", { name: `Collapse ${title}`, exact: true }).getAttribute("aria-expanded"), "true")
            await region.getByText(extraPort, { exact: true }).waitFor()
            await region.evaluate(node => { node.scrollLeft = node.scrollWidth }); await assertLastPricesReachable(region)
            if (title === "CHINA (EAST)") await page.screenshot({ path: path.join(screenshots, `${engine}-${width}-${colorScheme}-expanded.png`), fullPage: true })
            await page.getByRole("button", { name: `Collapse ${title}`, exact: true }).click()
            assert.equal(await region.getByText(extraPort, { exact: true }).count(), 0)
          }
          assert.equal(await page.getByText("Report Date: 12 Oct 2026", { exact: true }).count(), 1)
          assert.equal(await east.getByText("0", { exact: true }).count(), 1)
          assert.equal(await page.getByText("NA", { exact: true }).count(), 1)
          assert.equal(await page.getByText("1379.25", { exact: true }).count(), 1)
          assert.ok(await overflow(page) <= 1)
          if (width === 1280) {
            await page.goto(`${origin}/baseline`); await loaded(page)
            const oldImage = await page.screenshot({ path: path.join(screenshots, `${engine}-${width}-${colorScheme}-baseline-desktop.png`), fullPage: true })
            assert.equal(digest(originalImage), digest(oldImage), "fitting desktop screenshot stays pixel-identical to the released client")
          }
          verified.push({ engine, width, colorScheme, scrollWidth: before.scrollWidth, clientWidth: before.clientWidth, nativeTouchTested })
          console.log(`PASS ${engine} ${width} ${colorScheme}: all prices reachable; keyboard/native wheel; expansion; unchanged quote date/fallbacks`)
        } finally { await context.close() }
      }
    }
    assert.equal(verified.length, 16); assert.deepEqual(failures, []); assert.deepEqual(externalRequests, []); assert.equal(JSON.stringify(payload), originalPayload)
    assert.ok(requests.some(request => request.path === "/logo-trans.png"), "real repository logo was loaded")
    const result = { baselineCommit, verified, browserErrors: failures, externalRequests, apiReads, sourceSha256: digest(fs.readFileSync(path.join(root, clientPath))), screenshots,
      limitations: "Actual client/global CSS/logo with synthetic read-only report and Next Image/Link rendering adapters. No hosted SSR/CDN/auth/database or physical iPhone. Keyboard and native wheel tested in both engines; trusted Chromium touch pan tested when narrow content overflows, WebKit/physical-device touch gestures not claimed. Public report keeps its existing blue palette under either OS preference." }
    fs.writeFileSync(path.join(screenshots, "verification.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
  } finally { for (const browser of browsers) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
