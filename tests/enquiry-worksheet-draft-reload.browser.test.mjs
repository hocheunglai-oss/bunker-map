// Actual worksheet, synthetic auth/API responses, isolated headless browser.
// No credentials, production services, or personal browser profile are used.
import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const baseline = process.argv.includes("--baseline-stdin") ? JSON.parse(readFileSync(0, "utf8")) : {}
const cacheKey = "fc-admin-enquiry-worksheet-draft-v1"
const rawAlpha = "Vessel: ALPHA\nPort: Singapore\nVLSFO 100MT"
const unknownPortRaw = "Vessel: ALPHA\nETA: XERON 15 OCT\nVLSFO 100MT"
const entry = `
  import React from "react";
  import {createRoot} from "react-dom/client";
  import Worksheet from "./app/admin/enquiryworksheet/page";
  window.__requests=[];window.__ports=[];window.__reportWrites=[];
  window.fetch=(url,init={})=>{
    if(url==="/api/admin/enquiryworksheet/ports"){
      if(new URLSearchParams(location.search).has("deferPorts"))return new Promise(resolve=>window.__ports.push(resolve));
      return Promise.resolve(Response.json({ports:[]}));
    }
    if(url==="/api/parser-ai")return new Promise((resolve,reject)=>window.__requests.push({body:JSON.parse(init.body),resolve,reject}));
    if(url==="/api/parser-reports" && init.method==="POST"){
      window.__reportWrites.push(JSON.parse(init.body));return Promise.resolve(Response.json({success:true}));
    }
    throw Error("Unexpected synthetic request: "+url);
  };
  createRoot(document.getElementById("root")).render(<React.StrictMode><Worksheet/></React.StrictMode>);
`
const bundle = await build({
  absWorkingDir: root,
  stdin: { contents: entry, resolveDir: root, loader: "tsx" },
  outfile: "fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "synthetic-session-and-baseline", setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/useSimpleAdminAuth$/ }, () => ({ path: "auth", namespace: "fixture" }))
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export function useSimpleAdminAuth(){return {authenticated:true,displayName:"Synthetic User",username:"synthetic"}}', loader: "js" }))
    builder.onLoad({ filter: /enquiryworksheet\/page\.tsx$/ }, (args) => {
      const relative = path.relative(root, args.path)
      return baseline[relative] ? { contents: baseline[relative], loader: "tsx" } : undefined
    })
  } }],
})
const assets = new Map(bundle.outputFiles.map((file) => [path.basename(file.path), file.contents]))
const server = http.createServer((req, res) => {
  const name = new URL(req.url, "http://localhost").pathname.slice(1)
  if (assets.has(name)) {
    res.setHeader("Content-Type", name.endsWith("css") ? "text/css" : "text/javascript")
    return res.end(assets.get(name))
  }
  res.setHeader("Content-Type", "text/html")
  res.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const { chromium } = require("playwright")
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
  const context = await browser.newContext({ viewport: { width: 1700, height: 1200 } })
  const page = await context.newPage(), errors = [], blocked = [], failures = []
  page.setDefaultTimeout(7000)
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript((key) => {
    window.__cacheWrites = []
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (itemKey, value) {
      if (this === localStorage && itemKey === key) {
        try { window.__cacheWrites.push(JSON.parse(value)) } catch { /* Permit malformed-cache recovery scenarios. */ }
      }
      return setItem.call(this, itemKey, value)
    }
  }, cacheKey)
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  const button = (name) => page.getByRole("button", { name, exact: true })
  const raw = () => page.getByRole("textbox", { name: "Enquiry text", exact: true })
  const output = () => page.getByRole("textbox", { name: "Editable shortened enquiry", exact: true })
  const ai = () => button("Ask AI to correct shortened enquiry")
  const cache = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), cacheKey)
  const settled = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  async function reload(query = "") {
    await page.goto(`${origin}/worksheet${query}`)
    await raw().waitFor()
    await settled()
  }
  async function reset() {
    await reload()
    await page.evaluate(() => localStorage.clear())
    await reload()
  }
  async function seed(value, query = "") {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)), { key: cacheKey, value })
    await reload(query)
  }
  async function resolvePorts() {
    await page.evaluate(() => window.__ports.splice(0).forEach((resolve) => resolve(Response.json({ ports: ["XERON"] }))))
    await settled()
  }
  async function requestAi() {
    await ai().click()
    await page.waitForFunction(() => window.__requests.length > 0)
    return page.evaluate(() => window.__requests.length - 1)
  }
  async function resolveAi(index, payload) {
    await page.evaluate(({ index, payload }) => window.__requests[index].resolve(Response.json(payload)), { index, payload })
    await settled()
  }
  async function scenario(name, run) {
    await reset()
    try { await run(); console.log(`PASS ${name}`) }
    catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`) }
  }

  await scenario("manual multiline output, both UI remarks and worksheet survive actual reload", async () => {
    await raw().fill(rawAlpha)
    await button("180").click()
    await button("120").click()
    const draft = "  alpha / singapore / vlsfo 180cst max 120cst max 100mts\nKEEP MANUAL LINE  \n"
    await output().fill(draft)
    await page.getByRole("textbox", { name: "Enquiry working notes", exact: true }).fill("KEEP WORKING NOTES")
    await settled()
    assert.equal((await cache()).shortenedDraft, draft)
    await page.reload(); await settled()
    assert.equal(await output().inputValue(), draft)
    assert.equal(await button("180").getAttribute("aria-pressed"), "true")
    assert.equal(await button("120").getAttribute("aria-pressed"), "true")
    assert.equal(await page.getByRole("textbox", { name: "Enquiry working notes", exact: true }).inputValue(), "KEEP WORKING NOTES")
    assert.deepEqual((await cache()).vlsfoMaxRemarks, ["180cst max", "120cst max"])
  })

  await scenario("AI output and provenance survive reload/manual amendment and feed the actual report flow", async () => {
    await raw().fill(rawAlpha)
    const deterministicOutput = await output().inputValue()
    const index = await requestAi()
    const aiOutput = "ai alpha / singapore / vlsfo 80cst min 180cst max 123mts"
    await resolveAi(index, {
      model: "synthetic-model", correctedOutput: aiOutput,
      fields: { vesselName: "AI ALPHA", port: "singapore" },
      vlsfoMaxRemarks: ["80cst min", "180cst max"], confidence: 0.91,
      warnings: ["SYNTHETIC CAUTION"], imoSources: [{ title: "Synthetic source", url: "https://example.invalid/imo" }],
    })
    assert.equal(await output().inputValue(), aiOutput)
    await page.reload(); await settled()
    assert.equal(await output().inputValue(), aiOutput)
    assert.equal(await page.getByText("AI warning: SYNTHETIC CAUTION", { exact: true }).count(), 1)
    assert.equal(await page.getByRole("link", { name: "Synthetic source", exact: true }).getAttribute("href"), "https://example.invalid/imo")
    assert.equal(await ai().isDisabled(), false, "reload must not restore a pending AI request")
    assert.deepEqual((await cache()).vlsfoMaxRemarks, ["80cst min", "180cst max"])
    const amended = `${aiOutput} / MANUAL AFTER AI`
    await output().fill(amended); await settled(); await page.reload(); await settled()
    assert.equal(await output().inputValue(), amended)
    await button("Report incorrect parser output").click()
    const dialog = page.getByRole("dialog", { name: "Report Parser Output", exact: true })
    assert.equal(await dialog.getByLabel(/^PARSER OUTPUT/).inputValue(), deterministicOutput)
    assert.equal(await dialog.getByLabel(/^AI FIX/).inputValue(), aiOutput)
    await dialog.getByRole("button", { name: "Submit Report", exact: true }).click()
    await page.getByText("Report saved.", { exact: true }).waitFor()
    const write = await page.evaluate(() => window.__reportWrites.at(-1))
    assert.equal(write.correctedOutput, amended)
    assert.equal(write.metadata.aiFixOutput, aiOutput)
    assert.equal(write.metadata.aiSuggestion.model, "synthetic-model")
    assert.equal(write.metadata.aiSuggestion.parserOutput, deterministicOutput)
    assert.equal(write.metadata.aiSuggestion.confidence, 0.91)
    assert.deepEqual(write.metadata.aiSources, [{ title: "Synthetic source", url: "https://example.invalid/imo" }])
  })

  await scenario("explicitly blank output survives reload and does not resurrect when opening a report", async () => {
    await raw().fill(rawAlpha); await output().fill(""); await settled()
    await page.reload(); await settled()
    assert.equal(await output().inputValue(), "")
    assert.equal((await cache()).shortenedDraft, "")
    assert.equal(await button("Copy shortened enquiry").isDisabled(), true)
    await button("Report incorrect parser output").click()
    assert.equal(await page.getByRole("button", { name: "Submit Report", exact: true }).isDisabled(), true)
  })

  for (const draft of ["MANUAL RESTORED UNKNOWN PORT", ""]) {
    await scenario(`restored ${draft ? "nonempty" : "empty"} output survives delayed port discovery and fences an older AI request`, async () => {
      await seed({ enquiryText: unknownPortRaw, shortenedDraft: draft, vlsfoMaxRemarks: [] }, "?deferPorts=1")
      assert.equal(await output().inputValue(), draft)
      assert.equal(await page.getByLabel("PORT", { exact: true }).inputValue(), "")
      const index = await requestAi()
      await resolvePorts()
      assert.equal(await page.getByLabel("PORT", { exact: true }).inputValue(), "xeron")
      assert.equal(await output().inputValue(), draft)
      assert.equal((await cache()).shortenedDraft, draft)
      assert.equal(await ai().isDisabled(), false)
      await resolveAi(index, { correctedOutput: "STALE AI AFTER PORTS", fields: { vesselName: "STALE" } })
      assert.equal(await output().inputValue(), draft)
      assert.equal(await page.getByText("AI correction applied. Double check before sending.", { exact: true }).count(), 0)
    })
  }

  await scenario("changed original enquiry resets draft/provenance and never saves the prior output with new raw text", async () => {
    await raw().fill(rawAlpha)
    const index = await requestAi()
    await resolveAi(index, { correctedOutput: "AI OLD / vlsfo 180cst max 123mts", warnings: ["OLD WARNING"], fields: { vesselName: "AI OLD" } })
    await output().fill("MANUAL OLD TEXT")
    await page.evaluate(() => { window.__cacheWrites = [] })
    const nextRaw = "Vessel: BETA\nPort: Busan\nVLSFO 200MT"
    await raw().fill(nextRaw); await settled()
    const expected = await output().inputValue()
    assert.equal(expected, "beta / busan / vlsfo 200mts")
    const writes = await page.evaluate(() => window.__cacheWrites)
    assert.ok(writes.length > 0)
    for (const write of writes) {
      assert.equal(write.enquiryText, nextRaw)
      assert.equal(write.shortenedDraft, expected)
      assert.equal(write.parserAiSuggestion, null)
      assert.deepEqual(write.vlsfoMaxRemarks, [])
    }
    await page.reload(); await settled()
    assert.equal(await output().inputValue(), expected)
    assert.equal(await page.getByText("AI warning: OLD WARNING", { exact: true }).count(), 0)
  })

  await scenario("normalized-identical raw edit still resets owned output and has consistent cache snapshots", async () => {
    await raw().fill(rawAlpha)
    const expected = await output().inputValue()
    await output().fill("MANUAL OWNED OUTPUT")
    await page.evaluate(() => { window.__cacheWrites = [] })
    await raw().fill(`${rawAlpha} `); await settled()
    assert.equal(await output().inputValue(), expected)
    const writes = await page.evaluate(() => window.__cacheWrites)
    assert.ok(writes.length > 0)
    assert.ok(writes.every((write) => write.shortenedDraft === expected))
    await page.reload(); await settled()
    assert.equal(await output().inputValue(), expected)
  })

  await scenario("explicit vessel, IMO and port edits still regenerate shortened output", async () => {
    for (const [label, value, expectedPart] of [["VESSEL NAME", "BETA", "beta"], ["IMO", "9567348", "9567348"], ["PORT", "busan", "busan"]]) {
      await reset()
      await raw().fill(rawAlpha)
      await button("180").click()
      await output().fill("MANUAL BEFORE FIELD EDIT")
      await (label === "IMO" ? page.getByLabel(/^IMO/) : page.getByLabel(label, { exact: true })).fill(value); await settled()
      const regenerated = await output().inputValue()
      assert.ok(regenerated.includes(expectedPart), `${label} must update output: ${regenerated}`)
      assert.match(regenerated, /180cst max/i)
      assert.ok(!regenerated.includes("MANUAL"))
      assert.equal((await cache()).shortenedDraft, regenerated)
      await page.reload(); await settled()
      assert.equal(await output().inputValue(), regenerated)
    }
  })

  for (const [label, value, normalized] of [["VESSEL NAME", "alpha", "ALPHA"], ["IMO", "-", ""], ["PORT", "Singapore", "singapore"]]) {
    await scenario(`normalization-only ${label} retains the manual draft through reload while fencing AI`, async () => {
      await raw().fill(rawAlpha)
      const draft = "KEEP MANUAL SPECIAL TERMS"
      await output().fill(draft)
      const index = await requestAi()
      const field = label === "IMO" ? page.getByLabel(/^IMO/) : page.getByLabel(label, { exact: true })
      await field.fill(value); await settled()
      assert.equal(await field.inputValue(), normalized)
      assert.equal(await output().inputValue(), draft, `${label}: normalization-only edits must retain manual output`)
      assert.equal((await cache()).shortenedDraft, draft)
      assert.equal(await ai().isDisabled(), false, `${label}: even a normalization-only edit invalidates pending AI`)
      await resolveAi(index, { correctedOutput: "STALE AI AFTER NORMALIZED FIELD", fields: { vesselName: "STALE" } })
      assert.equal(await output().inputValue(), draft)
      assert.equal(await page.getByText("AI correction applied. Double check before sending.", { exact: true }).count(), 0)
      await page.reload(); await settled()
      assert.equal(await output().inputValue(), draft, `${label}: the retained draft must survive reload`)
      assert.equal((await cache()).shortenedDraft, draft)
    })
  }

  await scenario("worksheet-only edits retain exact output rather than taking parser ownership", async () => {
    await raw().fill(rawAlpha)
    await output().fill("KEEP EXACT OUTPUT")
    await page.getByRole("textbox", { name: "Vessel name and IMO", exact: true }).fill("WORKSHEET HEADER")
    await page.getByLabel("BUYER", { exact: true }).last().fill("WORKSHEET BUYER")
    await settled()
    assert.equal(await output().inputValue(), "KEEP EXACT OUTPUT")
    assert.equal((await cache()).shortenedDraft, "KEEP EXACT OUTPUT")
    await page.reload(); await settled()
    assert.equal(await output().inputValue(), "KEEP EXACT OUTPUT")
  })

  await scenario("Clear and reload never resurrect the old cache or an older pending AI result", async () => {
    await raw().fill(rawAlpha); await button("120").click(); await output().fill("OLD MANUAL DRAFT")
    const index = await requestAi()
    await button("Clear").click(); await settled()
    await resolveAi(index, { correctedOutput: "STALE AFTER CLEAR", fields: { vesselName: "STALE" } })
    assert.equal(await output().inputValue(), "")
    await page.reload(); await settled()
    assert.equal(await raw().inputValue(), "")
    assert.equal(await output().inputValue(), "")
    assert.deepEqual((await cache()).vlsfoMaxRemarks, [])
    assert.equal((await cache()).parserAiSuggestion, null)
  })

  await scenario("legacy cache without output regenerates and valid saved remarks are restored", async () => {
    await seed({ enquiryText: rawAlpha })
    assert.equal(await output().inputValue(), "alpha / singapore / vlsfo 100mts")
    await seed({ enquiryText: rawAlpha, vlsfoMaxRemarks: ["180cst max"] })
    assert.equal(await button("180").getAttribute("aria-pressed"), "true")
    assert.match(await output().inputValue(), /180cst max/i)
  })

  await scenario("malformed cache collections sanitize safely, preserving all four supported remark types", async () => {
    const draft = "EXACT CACHED OUTPUT"
    const remarks = ["80cst min", "80cst max", "120cst max", "180cst max"]
    await seed({
      enquiryText: rawAlpha, shortenedDraft: draft, vlsfoMaxRemarks: [...remarks, "180cst max", "BAD", null, {}],
      parserAiSuggestion: {
        model: {}, parserOutput: "", correctedOutput: "AI PROVENANCE", fields: { vesselName: {}, port: "singapore" },
        confidence: "not finite", vlsfoMaxRemarks: [...remarks, null], warnings: ["KEEP WARNING", 7, null, {}],
        imoSources: [{ title: "Safe source", url: "https://example.invalid/safe" }, { title: {}, url: "http://example.invalid/also-safe" }, { url: "javascript:alert(1)" }, null],
      },
    })
    assert.equal(await output().inputValue(), draft)
    const saved = await cache()
    assert.deepEqual(saved.vlsfoMaxRemarks, remarks)
    assert.deepEqual(saved.parserAiSuggestion.vlsfoMaxRemarks, remarks)
    assert.deepEqual(saved.parserAiSuggestion.warnings, ["KEEP WARNING"])
    assert.equal(saved.parserAiSuggestion.fields.vesselName, "")
    assert.equal(saved.parserAiSuggestion.confidence, 0)
    assert.deepEqual(saved.parserAiSuggestion.imoSources, [{ title: "Safe source", url: "https://example.invalid/safe" }, { title: "", url: "http://example.invalid/also-safe" }])
    await seed({ enquiryText: rawAlpha, shortenedDraft: {}, vlsfoMaxRemarks: {}, parserAiSuggestion: { correctedOutput: {} } })
    assert.equal(await output().inputValue(), "alpha / singapore / vlsfo 100mts")
    assert.equal((await cache()).parserAiSuggestion, null)
    await seed("{broken JSON")
    assert.equal(await raw().inputValue(), "")
    assert.equal(await output().inputValue(), "")
  })

  assert.deepEqual(errors, [], "actual page must not throw")
  assert.deepEqual(blocked, [], "fixture must not attempt external requests")
  assert.deepEqual(failures, [], `${failures.length} worksheet draft regression group(s) failed`)
  console.log("PASS isolated browser: 15 worksheet reload groups, no page errors or external requests")
  await context.close()
} finally {
  if (browser) await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
