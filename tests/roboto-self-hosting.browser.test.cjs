/* Isolated headless font parity check. The actual root layout and font CSS are
 * rendered with only analytics/CSS-module boundaries replaced; all fonts are
 * the pinned local assets. Nothing can leave the fixture origin. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const React = require("react")
const { renderToStaticMarkup } = require("react-dom/server")

async function main() {
  const root = path.resolve(__dirname, "..")
  const read = (file) => fs.readFileSync(path.join(root, file))
  const metadata = JSON.parse(read("docs/sitewide-font-self-hosting-2026-10-13.json"))
  const css = read("app/fonts/roboto.css").toString()
  const output = ts.transpileModule(read("app/layout.tsx").toString(), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(output, { exports, URL, process: { env: {} }, require(name) {
    if (name === "@vercel/analytics/next") return { Analytics: () => null }
    if (name === "@vercel/speed-insights/next") return { SpeedInsights: () => null }
    if (name === "react-dom") return require(name)
    if (name.endsWith(".css")) return {}
    assert.equal(name, "react/jsx-runtime")
    return require(name)
  } })
  const weights = [400, 500, 600, 700, 800, 900]
  const samples = ["FC Uno Report 1234567890", "Économie Łódź", "Привет Ґ", "Ӑ", "Αθήνα ἀ", "Tiếng Việt", "∑∫∞", "♠♣↔"]
  // Reference is the independently pinned published CSS, not candidate ranges.
  let referenceFaces = read("tests/fixtures/roboto-google-v51.css").toString().replaceAll("font-family: 'Roboto';", 'font-family: "Roboto Reference";')
  for (const asset of metadata.assets) referenceFaces = referenceFaces.split(asset.sourceUrl).join(asset.url)
  assert.ok(!referenceFaces.includes("https://"))
  function html(reference) {
    const family = reference ? '"Roboto Reference", "Roboto Fallback"' : 'var(--font-roboto)'
    const children = React.createElement("main", null, weights.flatMap((weight) => samples.map((sample, index) => React.createElement("div", { key: `${weight}-${index}`, className: "sample", "data-weight": weight, style: { fontFamily: family, fontWeight: weight } }, sample))))
    return "<!doctype html>" + renderToStaticMarkup(React.createElement(exports.default, { children })).replace("</head>", `<link rel="stylesheet" href="/font.css"><style>${reference ? referenceFaces : ""}body{margin:0;color:#111;background:#fff}main{padding:8px}.sample{font-size:21px;line-height:28px;width:max-content;white-space:pre}</style></head>`)
  }
  const assets = new Map(metadata.assets.map((asset) => [asset.url, read(asset.target)]))
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405); response.end(); return }
    const url = new URL(request.url, "http://127.0.0.1")
    if (assets.has(url.pathname)) { response.setHeader("Content-Type", "font/woff2"); response.end(assets.get(url.pathname)); return }
    if (url.pathname === "/font.css") { response.setHeader("Content-Type", "text/css"); response.end(css); return }
    response.setHeader("Content-Type", "text/html")
    response.end(html(url.pathname === "/reference"))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    const { chromium } = require("playwright")
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) })
    const failures = []
    async function capture(route) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 1500 }, deviceScaleFactor: 1 })
      try {
        const requests = []
        await context.route("**/*", (request) => {
          const url = new URL(request.request().url())
          if (url.origin !== origin) { failures.push(`External request blocked: ${url.origin}`); return request.abort() }
          if (assets.has(url.pathname)) requests.push(url.pathname)
          return request.continue()
        })
        const page = await context.newPage()
        page.on("pageerror", (error) => failures.push(error.message))
        await page.goto(`${origin}${route}`)
        // Explicitly exercise even subsets with no currently visible glyph.
        // This is test-only: production preloads Latin and fetches the rest on demand.
        await page.evaluate(() => Promise.all([...document.fonts].filter((font) => font.family === 'Roboto').map((font) => font.load())))
        await page.evaluate(() => document.fonts.ready)
        const details = await page.evaluate(() => ({
          variable: getComputedStyle(document.documentElement).getPropertyValue("--font-roboto").trim(),
          preloads: [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) => ({ href: new URL(link.href).pathname, type: link.type, crossOrigin: link.crossOrigin })),
          declaredWeights: [...new Set([...document.fonts].filter((font) => font.family === 'Roboto').map((font) => font.weight))].sort(),
          samples: [...document.querySelectorAll(".sample")].map((element) => ({ text: element.textContent, weight: getComputedStyle(element).fontWeight, family: getComputedStyle(element).fontFamily, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })),
        }))
        assert.deepEqual(details.preloads, [{ href: "/fonts/roboto/roboto-v51-latin.0a44e0bb6ba5c853.woff2", type: "font/woff2", crossOrigin: "anonymous" }])
        assert.deepEqual(details.declaredWeights, ["400", "500", "700", "900"])
        assert.equal(details.variable, '"Roboto", "Roboto Fallback"')
        const pixels = await page.screenshot({ fullPage: true })
        return { details, pixels, requests }
      } finally { await context.close() }
    }
    const actual = await capture("/current")
    const reference = await capture("/reference")
    assert.ok(actual.details.samples.every((sample) => sample.family.startsWith("Roboto,")))
    assert.deepEqual(actual.details.samples.map(({ family, ...sample }) => sample), reference.details.samples.map(({ family, ...sample }) => sample))
    assert.deepEqual(actual.pixels, reference.pixels, "all text pixels must match the previously pinned face/subset selection")
    assert.equal(new Set(actual.requests).size, 9, "all nine local subsets are usable")
    assert.equal(actual.requests.length, 9, "the same font bytes are not re-downloaded for each face weight")
    assert.deepEqual(failures, [])
    console.log("PASS: actual root layout has one Latin preload, local Roboto variable and exact four face weights")
    console.log("PASS: six computed weights (including existing 600/800 matching) and multilingual widths/pixels match the prior face rules")
    console.log("PASS: all nine subset assets load locally once each; no external font request or browser error")
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
