/* Run after next build --webpack. Starts only a credential-free, loopback Next
 * server, checks the emitted HTML/CSS/assets, then closes its own process. */
const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { createHash } = require("node:crypto")
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")

async function main() {
  const root = path.resolve(__dirname, "..")
  const evidence = JSON.parse(fs.readFileSync(path.join(root, "docs/sitewide-font-self-hosting-2026-10-13.json")))
  const socket = net.createServer()
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: { PATH: process.env.PATH || "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ENABLE_CN_REDIRECT: "true", NEXT_PUBLIC_CN_SITE_URL: "https://cn.example.invalid" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let exited = false
  child.on("exit", () => { exited = true })
  child.stdout.on("data", (data) => { output = (output + data).slice(-20000) })
  child.stderr.on("data", (data) => { output = (output + data).slice(-20000) })
  const origin = `http://127.0.0.1:${port}`
  const get = (url, host = "fcuno.com", country = "HK") => fetch(origin + url, { headers: { host, "x-vercel-ip-country": country }, redirect: "manual", signal: AbortSignal.timeout(5000) })
  try {
    for (let attempt = 0; ; attempt++) {
      try { const response = await get(evidence.assets[0].url); if (response.ok) break } catch {}
      assert.ok(!exited && attempt < 100, `Owned Next server did not start: ${output}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const config = require(path.join(root, "next.config.js"))
    const securityHeaders = (await config.headers()).find((rule) => rule.source === "/:path*").headers
    for (const host of ["fcuno.com", "spc.fcuno.com"]) for (const country of ["HK", "CN"]) for (const asset of evidence.assets) {
      const response = await get(asset.url, host, country)
      assert.equal(response.status, 200, asset.url)
      assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable", asset.url)
      assert.match(response.headers.get("content-type"), /font\/woff2/)
      for (const header of securityHeaders) assert.equal(response.headers.get(header.key), header.value, header.key)
      assert.equal(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), asset.sha256)
    }
    for (const host of ["fcuno.com", "spc.fcuno.com"]) {
      const licenseResponse = await get("/fonts/roboto/OFL.txt", host, "CN")
      assert.equal(licenseResponse.status, 200)
      assert.match(await licenseResponse.text(), /SIL OPEN FONT LICENSE Version 1\.1/)
      assert.doesNotMatch(licenseResponse.headers.get("cache-control") || "", /immutable/)
      const missingResponse = await get("/fonts/roboto/roboto-v51-latin.woff2", host)
      assert.equal(missingResponse.status, 404)
      assert.doesNotMatch(missingResponse.headers.get("cache-control") || "", /immutable/)
    }
    const cnPage = await get("/reports/taiwan?x=1", "fcuno.com", "CN")
    assert.equal(cnPage.status, 307)
    assert.equal(cnPage.headers.get("location"), "https://cn.example.invalid/reports/taiwan?x=1")
    const cnUnknownFont = await get("/fonts/roboto/arbitrary.txt", "fcuno.com", "CN")
    assert.equal(cnUnknownFont.status, 307)
    assert.equal(cnUnknownFont.headers.get("location"), "https://cn.example.invalid/fonts/roboto/arbitrary.txt")
    for (const [host, route] of [["fcuno.com", "/admin"], ["spc.fcuno.com", "/"]]) {
    const htmlResponse = await get(route, host)
    assert.equal(htmlResponse.status, 200)
    const html = await htmlResponse.text()
    const preloads = [...html.matchAll(/<link\b[^>]*>/g)].map((match) => match[0]).filter((link) => /rel="preload"/.test(link) && /as="font"/.test(link))
    assert.equal(preloads.length, 1)
    const latin = evidence.assets.find((asset) => asset.subset === "latin")
    assert.ok(preloads[0].includes(`href="${latin.url}"`))
    assert.match(preloads[0], /type="font\/woff2"/)
    assert.match(preloads[0], /crossorigin="(?:anonymous)?"/i)
    const styles = [...new Set([...html.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/g)].filter((match) => /rel="stylesheet"/.test(match[0])).map((match) => match[1]))]
    assert.ok(styles.length)
    let css = ""
    for (const href of styles) {
      assert.ok(href.startsWith("/_next/static/"), "built stylesheet must be local")
      const response = await get(href, host)
      assert.equal(response.status, 200)
      css += await response.text()
    }
    for (const asset of evidence.assets) assert.equal(css.split(asset.url).length - 1, 4, asset.subset)
    assert.match(css, /--font-roboto:\s*(?:"Roboto"|Roboto),\s*"Roboto Fallback"/)
    assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/)
    assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/)
    }
    console.log("PASS: actual built Next server serves all nine pinned font bytes with immutable caching/security headers on FCUNO and SPC, including CN visitors")
    console.log("PASS: license and unhashed paths are not immutable; CN page/unknown-font redirects remain intact")
    console.log("PASS: actual built FCUNO admin and SPC home HTML/CSS retain one Latin preload, all 36 local faces and no Google font URL")
  } finally {
    if (!exited) {
      const closed = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGTERM")
      const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL") }, 3000)
      await closed
      clearTimeout(timer)
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
