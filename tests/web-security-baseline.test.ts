import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const nextConfig = require("../next.config.js") as {
  poweredByHeader?: boolean
  headers?: () => Promise<
    Array<{
      source: string
      headers: Array<{ key: string; value: string }>
    }>
  >
}

function directiveValues(csp: string, directiveName: string) {
  const directive = csp
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${directiveName} `))
  assert.ok(directive, `${directiveName} should be configured`)
  return directive.slice(directiveName.length + 1).split(/\s+/)
}

const expectedOfficeFrameAncestors = [
  "'self'",
  "https://outlook.office.com",
  "https://outlook.office365.com",
  "https://*.office.com",
  "https://*.office365.com",
  "https://*.officeapps.live.com",
  "https://*.microsoft365.com",
  "https://*.cloud.microsoft",
]

test("global response headers retain the baseline and stage the application CSP", async () => {
  assert.equal(nextConfig.poweredByHeader, false)
  assert.equal(typeof nextConfig.headers, "function")

  const rules = await nextConfig.headers!()
  const globalRule = rules.find((rule) => rule.source === "/:path*")
  const spcApiRule = rules.find((rule) => rule.source === "/api/spc/:path*")
  assert.ok(globalRule, "global response-header rule should exist")
  assert.ok(spcApiRule, "SPC API response-header rule should exist")
  assert.deepEqual(spcApiRule.headers, [
    { key: "Cache-Control", value: "private, no-store" },
  ])

  const headers = new Map(
    globalRule.headers.map(({ key, value }) => [key.toLowerCase(), value]),
  )
  assert.equal(headers.get("x-content-type-options"), "nosniff")
  assert.equal(headers.get("referrer-policy"), "no-referrer")
  assert.equal(
    headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  )
  assert.equal(
    headers.has("strict-transport-security"),
    false,
    "Vercel supplies HSTS and the application should not duplicate it",
  )
  const enforcedCsp = headers.get("content-security-policy")
  assert.ok(enforcedCsp, "a safe CSP baseline should be enforced immediately")
  for (const directive of [
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "upgrade-insecure-requests",
  ]) {
    assert.match(
      enforcedCsp,
      new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    )
  }
  assert.deepEqual(
    directiveValues(enforcedCsp, "frame-ancestors"),
    expectedOfficeFrameAncestors,
    "the enforced framing policy should support legacy and current Microsoft 365 Outlook hosts",
  )

  const csp = headers.get("content-security-policy-report-only")
  assert.ok(csp, "report-only CSP should be configured")

  for (const directive of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ]) {
    assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }

  for (const requiredOrigin of [
    "https://s3.tradingview.com",
    "https://appsforoffice.microsoft.com",
    "https://api.maptiler.com",
    "https://*.tile.openstreetmap.org",
    "https://gglyugbrnyvyfktgwert.supabase.co",
    "https://www.googleapis.com",
    "https://drive.google.com",
    "https://docs.google.com",
    "https://www.hko.gov.hk",
  ]) {
    assert.ok(csp.includes(requiredOrigin), `${requiredOrigin} should be allowlisted`)
  }

  assert.deepEqual(
    directiveValues(csp, "frame-ancestors"),
    expectedOfficeFrameAncestors,
    "the staged policy should retain the same Outlook framing contract",
  )

  assert.deepEqual(directiveValues(csp, "connect-src"), [
    "'self'",
    "https://gglyugbrnyvyfktgwert.supabase.co",
    "https://api.maptiler.com",
    "https://www.googleapis.com",
  ])
  assert.deepEqual(directiveValues(csp, "img-src"), [
    "'self'",
    "data:",
    "blob:",
    "https://api.maptiler.com",
    "https://*.tile.openstreetmap.org",
  ])
  assert.deepEqual(directiveValues(csp, "media-src"), [
    "'self'",
    "data:",
    "blob:",
    "https://gglyugbrnyvyfktgwert.supabase.co",
  ])
  assert.deepEqual(directiveValues(csp, "frame-src"), [
    "'self'",
    "https://*.tradingview.com",
    "https://*.tradingview-widget.com",
    "https://drive.google.com",
    "https://docs.google.com",
    "https://www.hko.gov.hk",
  ])

  assert.doesNotMatch(csp, /default-src \*/)
  assert.doesNotMatch(csp, /connect-src[^;]*\shttps:\s/)
})

test("security.txt publishes the approved contact, both canonical URLs, and a renewable expiry", async () => {
  const [securityTxt, proxySource] = await Promise.all([
    readFile(
      new URL("../public/.well-known/security.txt", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../proxy.ts", import.meta.url), "utf8"),
  ])

  assert.match(securityTxt, /^Contact: mailto:info@cosulich\.it$/m)
  assert.match(
    securityTxt,
    /^Expires: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m,
  )
  assert.match(securityTxt, /^Preferred-Languages: en, it$/m)
  assert.deepEqual(
    [...securityTxt.matchAll(/^Canonical: (.+)$/gm)].map((match) => match[1]),
    [
      "https://fcuno.com/.well-known/security.txt",
      "https://spc.fcuno.com/.well-known/security.txt",
    ],
  )

  const expires = securityTxt.match(/^Expires: (.+)$/m)?.[1]
  assert.ok(expires)
  const remainingMs = Date.parse(expires) - Date.now()
  assert.ok(
    remainingMs >= 90 * 24 * 60 * 60 * 1000,
    "security.txt should be renewed before fewer than 90 days remain",
  )
  assert.ok(
    remainingMs <= 366 * 24 * 60 * 60 * 1000,
    "RFC 9116 expiry should not be more than one year in the future",
  )
  assert.match(
    proxySource,
    /pathname === "\/\.well-known\/security\.txt"[\s\S]*?NextResponse\.next\(\)/,
    "the SPC hostname rewrite must preserve the standard security.txt path",
  )
})
