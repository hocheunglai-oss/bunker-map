import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { NextRequest } from "next/server"
import { proxy } from "../proxy"

const root = new URL("../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root))
const evidence = JSON.parse(read("docs/sitewide-font-self-hosting-2026-10-13.json").toString()) as {
  assets: Array<{ subset: string; target: string; url: string; unicodeRange: string; bytes: number; sha256: string; sourceUrl: string }>
}
const css = read("app/fonts/roboto.css").toString()
const layout = read("app/layout.tsx").toString()
const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1])
const weights = [400, 500, 700, 900]

function unicodeIntervals(range: string) {
  return range.toLowerCase().replaceAll(" ", "").split(",").map((entry) => {
    const value = entry.replace(/^u\+/, "")
    if (value.includes("?")) return [parseInt(value.replaceAll("?", "0"), 16), parseInt(value.replaceAll("?", "f"), 16)]
    const [start, end = start] = value.split("-")
    return [parseInt(start, 16), parseInt(end, 16)]
  })
}

test("root layout uses bundled Roboto without Google font loading and preloads Latin only", () => {
  assert.doesNotMatch(layout, /next\/font\/google|fonts\.googleapis|fonts\.gstatic/)
  assert.match(layout, /import "\.\/fonts\/roboto\.css"/)
  assert.match(layout, /import \{ preload \} from "react-dom"/)
  assert.equal([...layout.matchAll(/\bpreload\(/g)].length, 1)
  assert.match(layout, /preload\("\/fonts\/roboto\/roboto-v51-latin\.0a44e0bb6ba5c853\.woff2", \{ as: "font", type: "font\/woff2", crossOrigin: "anonymous" \}\)/)
  assert.doesNotMatch(layout, /<link/)
  assert.doesNotMatch(css, /https?:\/\/|@import/)
  assert.match(read("app/globals.css").toString(), /font-family: var\(--font-roboto\), "Roboto"/)
})

test("all nine published subsets retain the exact previously built WOFF2 bytes", () => {
  assert.deepEqual(evidence.assets.map((asset) => asset.subset), ["cyrillic-ext", "cyrillic", "greek-ext", "greek", "math", "symbols", "vietnamese", "latin-ext", "latin"])
  assert.equal(evidence.assets.reduce((sum, asset) => sum + asset.bytes, 0), 192232)
  for (const asset of evidence.assets) {
    const buffer = read(asset.target)
    assert.equal(buffer.subarray(0, 4).toString(), "wOF2")
    assert.equal(buffer.length, asset.bytes)
    assert.equal(createHash("sha256").update(buffer).digest("hex"), asset.sha256, asset.subset)
    assert.ok(asset.url.endsWith(`.${asset.sha256.slice(0, 16)}.woff2`), "immutable asset URL must identify its bytes")
  }
})

test("only content-addressed font assets receive immutable caching without replacing security headers", async () => {
  const require = createRequire(import.meta.url)
  const config = require("../next.config.js")
  const headers = await config.headers() as Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  const fontRule = headers.find((rule) => rule.source.startsWith("/fonts/roboto/"))!
  assert.ok(fontRule)
  assert.equal(fontRule.source, "/fonts/roboto/:font(roboto-v51-[a-z-]+\\.[a-f0-9]{16}\\.woff2)")
  assert.deepEqual(fontRule.headers, [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }])
  assert.deepEqual(headers.find((rule) => rule.source === "/api/spc/:path*")!.headers, [{ key: "Cache-Control", value: "private, no-store" }])
  const security = headers.find((rule) => rule.source === "/:path*")!.headers
  assert.deepEqual(security.map((header) => header.key), ["Content-Security-Policy", "Content-Security-Policy-Report-Only", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"])
  assert.ok(security.find((header) => header.key === "Content-Security-Policy")!.value.includes("frame-ancestors 'self' https://outlook.office.com"))
  assert.ok(security.find((header) => header.key === "Content-Security-Policy-Report-Only")!.value.includes("font-src 'self' data:"))
})

test("discrete 400/500/700/900 faces and all Unicode ranges remain unchanged", () => {
  assert.equal(faces.length, 37)
  for (const asset of evidence.assets) {
    const subsetFaces = faces.filter((face) => face.includes(`url("${asset.url}")`))
    assert.equal(subsetFaces.length, 4, asset.subset)
    assert.deepEqual(subsetFaces.map((face) => Number(/font-weight:\s*(\d+);/.exec(face)![1])), weights)
    for (const face of subsetFaces) {
      assert.match(face, /font-family: "Roboto";/)
      assert.match(face, /font-style: normal;/)
      assert.match(face, /font-stretch: 100%;/)
      assert.match(face, /font-display: swap;/)
      assert.equal(/unicode-range:\s*([^;]+);/.exec(face)![1], asset.unicodeRange)
    }
  }
  assert.doesNotMatch(css, /font-weight:\s*\d+\s+\d+/)
})

test("every face independently matches the pinned official Google CSS rather than the candidate manifest alone", () => {
  const original = read("tests/fixtures/roboto-google-v51.css")
  assert.equal(createHash("sha256").update(original).digest("hex"), "8e669fb5e4b5f9ffa09f93041826ed0a21d843e8e438bc6fefed7114f3fab1eb")
  const publishedFaces = [...original.toString().matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1])
  assert.equal(publishedFaces.length, 36)
  for (const asset of evidence.assets) for (const weight of weights) {
    const originalFace = publishedFaces.find((face) => face.includes(asset.sourceUrl) && new RegExp(`font-weight: ${weight};`).test(face))!
    const currentFace = faces.find((face) => face.includes(asset.url) && new RegExp(`font-weight: ${weight};`).test(face))!
    assert.ok(originalFace)
    assert.ok(currentFace)
    assert.deepEqual(unicodeIntervals(/unicode-range:\s*([^;]+);/.exec(currentFace)![1]), unicodeIntervals(/unicode-range:\s*([^;]+);/.exec(originalFace)![1]))
    for (const property of ["font-style: normal;", `font-weight: ${weight};`, "font-stretch: 100%;", "font-display: swap;"]) assert.ok(originalFace.includes(property) && currentFace.includes(property))
  }
})

test("only the nine pinned fonts and license bypass SPC and CN routing; pages and unknown assets remain unchanged", () => {
  const previous = { enable: process.env.ENABLE_CN_REDIRECT, site: process.env.NEXT_PUBLIC_CN_SITE_URL }
  process.env.ENABLE_CN_REDIRECT = "true"
  process.env.NEXT_PUBLIC_CN_SITE_URL = "https://cn.example.invalid"
  const request = (host: string, pathname: string, country = "CN") => new NextRequest(`https://${host}${pathname}`, { headers: { host, "x-vercel-ip-country": country } })
  try {
    for (const host of ["fcuno.com", "spc.fcuno.com"]) for (const pathname of [...evidence.assets.map((asset) => asset.url), "/fonts/roboto/OFL.txt"]) {
      const response = proxy(request(host, pathname))
      assert.equal(response.headers.get("x-middleware-next"), "1", `${host}${pathname}`)
      assert.equal(response.headers.get("x-middleware-rewrite"), null)
      assert.equal(response.headers.get("location"), null)
    }
    for (const pathname of ["/fonts/roboto/roboto-v51-latin.woff2", "/fonts/roboto/roboto-v51-latin.0000000000000000.woff2", "/fonts/roboto/arbitrary.txt", "/fonts/other/roboto.woff2", "/fonts/roboto/OFL.txt/child"]) {
      assert.equal(proxy(request("spc.fcuno.com", pathname)).headers.get("x-middleware-rewrite"), `https://spc.fcuno.com/spc${pathname}`)
      assert.equal(proxy(request("fcuno.com", pathname)).headers.get("location"), `https://cn.example.invalid${pathname}`)
    }
    assert.equal(proxy(request("fcuno.com", "/reports/taiwan?x=1")).headers.get("location"), "https://cn.example.invalid/reports/taiwan?x=1")
    assert.equal(proxy(request("fcuno.com", "/admin", "HK")).headers.get("x-middleware-next"), "1")
    assert.equal(proxy(request("spc.fcuno.com", "/")).headers.get("x-middleware-rewrite"), "https://spc.fcuno.com/spc")
    assert.equal(proxy(request("spc.fcuno.com", "/spc/enquiries")).headers.get("location"), "https://spc.fcuno.com/enquiries")
  } finally {
    if (previous.enable === undefined) delete process.env.ENABLE_CN_REDIRECT; else process.env.ENABLE_CN_REDIRECT = previous.enable
    if (previous.site === undefined) delete process.env.NEXT_PUBLIC_CN_SITE_URL; else process.env.NEXT_PUBLIC_CN_SITE_URL = previous.site
  }
})

test("existing Arial fallback metrics and global font variable remain exact", () => {
  const fallback = faces.find((face) => face.includes('font-family: "Roboto Fallback"'))!
  assert.ok(fallback)
  for (const property of ['src: local("Arial");', "ascent-override: 92.98%;", "descent-override: 24.47%;", "line-gap-override: 0.00%;", "size-adjust: 99.78%;"]) assert.ok(fallback.includes(property), property)
  assert.match(css, /--font-roboto: "Roboto", "Roboto Fallback";/)
})

test("bundled Roboto metadata and redistributed license match the published assets", () => {
  const require = createRequire(import.meta.url)
  const fontkit = require("next/dist/compiled/@next/font/dist/fontkit").default
  const fontFromBuffer = fontkit.default || fontkit
  for (const asset of evidence.assets) {
    const font = fontFromBuffer(read(asset.target))
    assert.equal(font.familyName, "Roboto")
    assert.equal(font.version, "Version 3.015; 2026")
    assert.equal(font.copyright, "Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic)")
    assert.equal(font.variationAxes.wght.min, 100)
    assert.equal(font.variationAxes.wght.max, 900)
  }
  const license = read("public/fonts/roboto/OFL.txt").toString()
  assert.match(license, /Copyright 2011 The Roboto Project Authors/)
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.match(license, /each copy\s+contains the above copyright notice and this license/)
})
