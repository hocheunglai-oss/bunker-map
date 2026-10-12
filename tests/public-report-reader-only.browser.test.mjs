// Reproducible reader-only regression: nine runtime overlays and an additive
// timestamp-validation helper over an immutable production Git baseline.
// No unpublished writer module, publication API or SQL fixture is imported;
// no mutation function or live service is used. The actual report route/reader and four actual clients run against
// a synthetic read-only remarks adapter. Next Link/Image/cache/Response are
// explicit test boundaries; this is not Next SSR, hosted authentication or CDN
// verification. Browsers use owned headless contexts and block external URLs.
//
// From the repository root:
// PUBLIC_READER_BASE_COMMIT=d262f1aea70a2cb8ad972869c1dd0bdb375732dd \
// NODE_PATH=<bundled dependencies> node tests/public-report-reader-only.browser.test.mjs
//
// In the isolated release checkout, append --require-clean-candidate. It also
// requires the on-disk history module to equal baseline plus only the helper,
// and every used noncandidate source module to match the pinned Git baseline.
// Supply PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH where Chrome is not installed.
// The baseline Git object must be available; missing history fails, not skips.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const assert = require("node:assert/strict");
const fs = require("node:fs"), cp = require("node:child_process"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const esbuild = require("esbuild"), { chromium } = require("playwright");
const base = process.env.PUBLIC_READER_BASE_COMMIT || "d262f1aea70a2cb8ad972869c1dd0bdb375732dd", root = process.cwd();
const strictCandidate = process.argv.includes("--require-clean-candidate");
const baselineCache = new Map();
assert.match(base, /^[a-f0-9]{40}$/i, "Pin an immutable full production Git commit.");
const selected = ["app/api/reports/[key]/route.ts", "app/reports/china/page.tsx", "app/reports/compact/page.tsx", "app/reports/china/ChinaReportClient.tsx", "app/reports/compact/CompactReportClient.tsx", "app/reports/hongkong/HongKongReportClient.tsx", "app/reports/taiwan/TaiwanReportClient.tsx", "lib/publicMarketData.ts", "lib/publicReportValidation.ts"];
const baseline = file => {
  if (!baselineCache.has(file)) baselineCache.set(file, cp.execFileSync("git", ["show", base + ":" + file], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  return baselineCache.get(file);
};
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const oldHistory = baseline("lib/priceHistoryRecords.ts"), dirtyHistory = fs.readFileSync("lib/priceHistoryRecords.ts", "utf8");
const helper = dirtyHistory.slice(dirtyHistory.indexOf("const marketTimestampFormatter"), dirtyHistory.indexOf("function getErrorMessage"));
assert.ok(helper.includes("export function normaliseHistoryTimestamp"));
const minimalHistory = oldHistory.replace("function getErrorMessage", helper + "function getErrorMessage");
if (strictCandidate) assert.equal(dirtyHistory === minimalHistory, true, "The candidate history module must contain only the additive timestamp helper; no unpublished writer edits.");
assert.equal(minimalHistory.slice(minimalHistory.indexOf("export async function savePriceHistoryForMarketDate")), oldHistory.slice(oldHistory.indexOf("export async function savePriceHistoryForMarketDate")));
const selectedText = new Map(selected.map(file => [file, fs.readFileSync(file, "utf8")]));
selectedText.set("lib/priceHistoryRecords.ts", minimalHistory);
const source = file => {
  if (selectedText.has(file)) return selectedText.get(file);
  const text = baseline(file);
  if (strictCandidate) assert.equal(fs.readFileSync(file, "utf8") === text, true, "Unexpected noncandidate source change: " + file);
  return text;
};
const filesUsed = new Set(), known = new Map();
function resolveFile(rel) { for (const suffix of ["", ".ts", ".tsx", ".js", ".mjs"]) { try { source(rel + suffix); return rel + suffix; } catch {} } throw Error("Unknown candidate dependency: " + rel); }
const store = new Map(), ids = { china: 103, compact: 104, taiwan: 101, hongkong: 102 };
let rowsOverride, readFailure = false;
const reads = [], cacheCalls = [];
const extras = {
  "next/server": { NextResponse: { json: Response.json.bind(Response) } },
  "next/cache": { unstable_cache(fn, keys) { cacheCalls.push(keys); return fn; } },
  "@supabase/supabase-js": { createClient(url, key) {
    assert.equal(url, "https://synthetic.invalid"); assert.equal(key, "synthetic-only");
    return { from(table) {
      assert.equal(table, "remarks");
      return { select(columns) {
        assert.equal(columns, "id,content");
        return { async in(column, wanted) {
          assert.equal(column, "id"); reads.push([...wanted]);
          if (readFailure) return { data: null, error: Error("Synthetic backend unavailable") };
          return { data: rowsOverride === undefined ? wanted.filter(id => store.has(id)).map(id => ({ id, content: store.get(id) })) : rowsOverride, error: null };
        } };
      } };
    } };
  } },
};
function load(file) {
  if (known.has(file)) return known.get(file);
  filesUsed.add(file); const loaded = { exports: {} }; known.set(file, loaded.exports);
  const code = esbuild.transformSync(source(file), { loader: file.endsWith("tsx") ? "tsx" : "ts", format: "cjs", target: "node24" }).code;
  new Function("require", "module", "exports", "process", "console", code)(name => {
    if (extras[name]) return extras[name];
    if (name.startsWith("@/")) return load(resolveFile(name.slice(2)));
    throw Error("Unexpected server import: " + name);
  }, loaded, loaded.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" } }, { error() {} });
  known.set(file, loaded.exports); return loaded.exports;
}
for (const file of ["app/reports/china/page.tsx", "app/reports/compact/page.tsx"]) {
  assert.match(source(file), /export const dynamic = "force-dynamic"/);
  assert.match(source(file), /export const revalidate = 0/);
}
const market = load("lib/publicMarketData.ts"), route = load("app/api/reports/[key]/route.ts");
assert.deepEqual(cacheCalls, [["public-homepage-market-data-v1"]]);
function snapshot(key, date = "08 Oct 2026") {
  const v = { today: 0, last: 10, change: -10 }, h = { today: 0, last1: 10, last2: null };
  if (["china", "compact"].includes(key)) return { reportDate: date, sections: [{ title: "CHINA (NORTH)", rows: [{ port: "Dalian", hsfo: 0, vlsfo: null, mgo: 123 }] }] };
  if (key === "hongkong") return { reportDate: date, rows: [{ port: "Hong Kong", todayDate: "2026-09-01T23:30:00.000003", last1Date: "2026-08-31T12:00:00", last2Date: null, hsfo: { ...h }, vlsfo: { ...h, today: null }, mgo: { ...h, today: 123 } }] };
  return { reportDate: date, remark: "Stored remark\nSecond line", rows: ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"].map(port => ({ port, hsfo: { ...v }, vlsfo: { ...v, today: null, change: null }, mgo: { ...v, today: 123 } })) };
}
const validFallbacks = JSON.stringify({ "dalian::vlsfo": "NA", "hong kong::vlsfo": "SE", "kaohsiung::vlsfo": "NA" });
const validNotice = JSON.stringify({ active: false, typhoonName: "", expectedReopenDate: "" });
for (const key of Object.keys(ids)) store.set(ids[key], JSON.stringify(snapshot(key)));
store.set(105, validFallbacks); store.set(2, "Notice line one\nNotice line two"); store.set(3, validNotice);
const read = key => route.GET(new Request("http://localhost/api/reports/" + key), { params: Promise.resolve({ key }) });
(async () => {
  let browser, server; const errors = [], external = []; let groups = 0;
  try {
    for (const key of Object.keys(ids)) {
      const r = await read(key); assert.equal(r.status, 200);
      for (const header of ["cache-control", "cdn-cache-control", "vercel-cdn-cache-control"]) assert.match(r.headers.get(header), /no-store/);
      assert.deepEqual((await r.json()).snapshot, snapshot(key));
    }
    for (const rows of [null, {}, [null], [{ id: "103", content: null }], [{ id: 103, content: null }, { id: 103, content: null }]]) { rowsOverride = rows; assert.equal((await read("china")).status, 502); } rowsOverride = undefined;
    for (const value of ["{broken", "[]", '{"dalian::vlsfo":{}}']) { store.set(105, value); assert.equal((await read("china")).status, 502); } store.set(105, validFallbacks);
    for (const value of ['{"active":"false"}', '{"active":true,"typhoonName":{}}']) { store.set(3, value); assert.equal((await read("taiwan")).status, 502); } store.set(3, validNotice);
    for (const value of ["{broken", JSON.stringify({ reportDate: "08 Oct 2026", sections: {} })]) { store.set(103, value); assert.equal((await read("china")).status, 502); } store.set(103, JSON.stringify(snapshot("china")));
    const beforeReads = reads.length; assert.equal((await read("__proto__")).status, 404); assert.equal(reads.length, beforeReads);
    groups++; console.log("PASS actual candidate reader/route: four formats, strict stored data/fallback/notice guards, generic failures and no-store headers");
    const titles = { china: "China", compact: "Compact", hongkong: "HongKong", taiwan: "Taiwan" };
    const entry = "import React from 'react';import{createRoot}from'react-dom/client';" + Object.keys(ids).map(key => "import " + key + " from '@/app/reports/" + key + "/" + titles[key] + "ReportClient';").join("") + "const all={china,compact,taiwan,hongkong};const C=all[window.fixtureKey];createRoot(document.getElementById('root')).render(<React.StrictMode><C initialData={window.fixtureInitial}/></React.StrictMode>);";
    const mock = "import React from 'react';export default function Mock({children,src,fill,priority,...props}){return src?React.createElement('img',{...props,src:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='}):React.createElement('a',props,children)}";
    const build = await esbuild.build({
      stdin: { contents: entry, loader: "tsx", resolveDir: root }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
      plugins: [{ name: "production-base-candidate", setup(build) {
        build.onResolve({ filter: /^next\/(?:link|image)$/ }, args => ({ path: args.path, namespace: "next-mock" }));
        build.onLoad({ filter: /.*/, namespace: "next-mock" }, () => ({ contents: mock, loader: "tsx", resolveDir: root }));
        build.onResolve({ filter: /^@\// }, args => ({ path: path.join(root, resolveFile(args.path.slice(2))) }));
        build.onLoad({ filter: /\.(?:ts|tsx|js|mjs)$/ }, args => {
          if (!args.path.startsWith(root + "/") || args.path.includes("/node_modules/")) return;
          const file = path.relative(root, args.path); filesUsed.add(file);
          return { contents: source(file), loader: args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".ts") ? "ts" : "js", resolveDir: path.dirname(args.path) };
        });
      } }],
    });
    const script = build.outputFiles[0].text;
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(script); return; }
        if (url.pathname.startsWith("/api/reports/")) { const r = await read(url.pathname.split("/").pop()); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return; }
        const key = url.pathname.slice(1); if (!Object.hasOwn(ids, key)) { res.writeHead(404); res.end(); return; }
        const r = await read(key), initial = r.status === 200 ? await r.json() : market.getEmptyPublicReportData(key);
        res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><html><body><div id="root"></div><script>window.fixtureKey=' + JSON.stringify(key) + ";window.fixtureInitial=" + JSON.stringify(initial).replaceAll("<", "\\u003c") + ';</script><script src="/bundle.js"></script></body></html>');
      } catch (e) { errors.push(e.message); res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      (fs.existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
    browser = await chromium.launch({ headless: true, ...(browserExecutable ? { executablePath: browserExecutable } : {}) });
    for (const key of Object.keys(ids)) {
      const context = await browser.newContext({ timezoneId: "America/Los_Angeles", viewport: { width: 1400, height: 1000 } });
      await context.route("**/*", r => { const url = new URL(r.request().url()); if (url.origin === origin) return r.continue(); external.push(url.origin); return r.abort(); });
      const page = await context.newPage(); page.setDefaultTimeout(7000); page.on("pageerror", e => errors.push(e.message));
      await page.goto(origin + "/" + key); await page.getByText("Report Date: 08 Oct 2026", { exact: true }).waitFor(); await page.waitForTimeout(60);
      let text = await page.locator("body").innerText(); assert.match(text, /\b0\b/); assert.match(text, key === "hongkong" ? /SE/ : /NA/);
      if (key === "hongkong") assert.ok(text.includes("01/09/2026")); if (key === "taiwan") assert.ok(text.includes("Notice line one") && text.includes("Notice line two")); groups++;
      const focus = () => page.evaluate(() => window.dispatchEvent(new Event("focus"))), date = day => page.getByText("Report Date: " + day, { exact: true });
      store.set(ids[key], JSON.stringify(snapshot(key, "10 Oct 2026"))); await focus(); await date("10 Oct 2026").waitFor(); groups++;
      readFailure = true; await focus(); await page.waitForTimeout(80); assert.equal(await date("10 Oct 2026").count(), 1); readFailure = false;
      for (const kind of ["disconnect", "json", "shape"]) {
        await page.route("**/api/reports/" + key, r => kind === "disconnect" ? r.abort("connectionfailed") : r.fulfill({ status: 200, contentType: "application/json", body: kind === "json" ? "{broken" : JSON.stringify({ ...market.getEmptyPublicReportData(key), snapshot: { reportDate: "12 Oct 2026", rows: {}, sections: {} } }) }));
        await focus(); await page.waitForTimeout(80); assert.equal(await date("10 Oct 2026").count(), 1); await page.unroute("**/api/reports/" + key);
      } groups++;
      let releaseOld, capture; const captured = new Promise(resolve => capture = resolve); let first = true;
      await page.route("**/api/reports/" + key, async r => {
        if (!first) return r.continue(); first = false;
        const response = await r.fetch(), body = await response.body();
        await new Promise(resolve => { releaseOld = resolve; capture(); }); await r.fulfill({ response, body }).catch(() => {});
      });
      let captureTimer;
      await focus();
      try { await Promise.race([captured, new Promise((_, reject) => { captureTimer = setTimeout(() => reject(Error("capture timeout")), 5000); })]); }
      finally { clearTimeout(captureTimer); }
      store.set(ids[key], JSON.stringify(snapshot(key, "11 Oct 2026"))); await focus(); await date("11 Oct 2026").waitFor(); releaseOld();
      await page.waitForTimeout(80); assert.equal(await date("11 Oct 2026").count(), 1); await page.unroute("**/api/reports/" + key); groups++;
      const saved = store.get(ids[key]);
      for (const value of ["{broken", JSON.stringify({ reportDate: "11 Oct 2026", rows: {}, sections: {} })]) {
        store.set(ids[key], value); assert.equal((await read(key)).status, 502);
        await focus(); await page.waitForTimeout(70); assert.equal(await date("11 Oct 2026").count(), 1);
        await page.reload(); await page.getByRole("status").filter({ hasText: "This report is temporarily unavailable." }).waitFor();
        store.set(ids[key], saved); await focus(); await date("11 Oct 2026").waitFor(); assert.equal(await page.getByRole("status").count(), 0);
      }
      groups++; await context.close(); console.log("PASS " + key + ": actual StrictMode client, saved dates/zero/fallback/notice, refresh, failure, reordered replies, cold-corruption and recovery");
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(JSON.stringify({ baseCommit: base, mode: strictCandidate ? "strict-clean-candidate" : "production-base-overlays", groups, readerCalls: reads.length, browserErrors: errors.length, externalRequests: external.length, sourceFiles: [...filesUsed].sort(), minimalHistoryHash: sha(minimalHistory), helperHash: sha(helper), writerFunctionUnchanged: true, sourceHashes: Object.fromEntries([...selectedText].map(([file,content])=>[file,sha(content)])), limits: "Actual candidate reader/route/client components with synthetic read-only SDK and Next rendering primitives; not Next SSR/CDN or hosted service proof" }));
  } finally { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });

