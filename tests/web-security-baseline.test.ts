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

test("global response headers retain the baseline and stage the application CSP", async () => {
  assert.equal(nextConfig.poweredByHeader, false)
  assert.equal(typeof nextConfig.headers, "function")

  const rules = await nextConfig.headers!()
  const globalRule = rules.find((rule) => rule.source === "/:path*")
  assert.ok(globalRule, "global response-header rule should exist")

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

test("security.txt publishes the approved contact and a one-year expiry", async () => {
  const [securityTxt, proxySource] = await Promise.all([
    readFile(
      new URL("../public/.well-known/security.txt", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../proxy.ts", import.meta.url), "utf8"),
  ])

  assert.match(securityTxt, /^Contact: mailto:info@cosulich\.it$/m)
  assert.match(securityTxt, /^Expires: 2027-08-06T00:00:00Z$/m)
  assert.match(securityTxt, /^Preferred-Languages: en, it$/m)
  assert.match(
    securityTxt,
    /^Canonical: https:\/\/spc\.fcuno\.com\/\.well-known\/security\.txt$/m,
  )

  const expires = securityTxt.match(/^Expires: (.+)$/m)?.[1]
  assert.ok(expires)
  assert.equal(
    Date.parse(expires),
    Date.parse("2026-08-06T00:00:00Z") + 365 * 24 * 60 * 60 * 1000,
  )
  assert.match(
    proxySource,
    /pathname === "\/\.well-known\/security\.txt"[\s\S]*?NextResponse\.next\(\)/,
    "the SPC hostname rewrite must preserve the standard security.txt path",
  )
})
