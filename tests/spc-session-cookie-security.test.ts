import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  getSpcSessionExpiry,
  SPC_SESSION_DURATION_SECONDS,
} from "../lib/spcSessions"

const authSource = readFileSync(
  new URL("../lib/spcAuth.ts", import.meta.url),
  "utf8",
)

function sourceBetween(start: string, end: string) {
  const startIndex = authSource.indexOf(start)
  const endIndex = authSource.indexOf(end, startIndex)
  assert.notEqual(startIndex, -1, `Missing source boundary: ${start}`)
  assert.notEqual(endIndex, -1, `Missing source boundary: ${end}`)
  return authSource.slice(startIndex, endIndex)
}

test("SPC session cookies retain browser security protections", () => {
  const persistentOptions = sourceBetween(
    "function cookieOptions",
    "function expiredCookieOptions",
  )
  const expiredOptions = sourceBetween(
    "function expiredCookieOptions",
    "function clearSpcCookies",
  )

  for (const options of [persistentOptions, expiredOptions]) {
    assert.match(options, /httpOnly:\s*true/)
    assert.match(options, /sameSite:\s*"lax"/)
    assert.match(
      options,
      /secure:\s*process\.env\.NODE_ENV\s*===\s*"production"/,
    )
    assert.match(options, /path:\s*"\/"/)
    assert.doesNotMatch(options, /\bdomain\s*:/i)
  }

  assert.match(
    persistentOptions,
    /maxAge:\s*Math\.min\(SPC_SESSION_DURATION_SECONDS, remainingSeconds\)/,
  )
  assert.match(persistentOptions, /const expires = new Date\(expiresAt\)/)
  assert.match(persistentOptions, /\n\s*expires,/)
})

test("SPC cookie lifetime and clear paths remain complete", () => {
  const now = new Date("2026-08-07T04:00:00.000Z")
  const expiresAt = getSpcSessionExpiry(now)
  assert.equal(SPC_SESSION_DURATION_SECONDS, 400 * 24 * 60 * 60)
  assert.equal(
    Date.parse(expiresAt) - now.getTime(),
    SPC_SESSION_DURATION_SECONDS * 1000,
  )

  const expiredOptions = sourceBetween(
    "function expiredCookieOptions",
    "function clearSpcCookies",
  )
  const clearCookies = sourceBetween(
    "function clearSpcCookies",
    "export async function setSpcSession",
  )
  const setSession = sourceBetween(
    "export async function setSpcSession",
    "export async function clearSpcSession",
  )
  const clearSession = sourceBetween(
    "export async function clearSpcSession",
    "function unauthenticatedSession",
  )
  const refreshedSession = sourceBetween(
    "export async function getRefreshedSpcSession",
    "export async function requireSpcSession",
  )

  assert.match(expiredOptions, /maxAge:\s*0/)
  assert.match(
    clearCookies,
    /cookieStore\.set\(SPC_COOKIE_NAME,\s*"",\s*options\)/,
  )
  assert.match(
    clearCookies,
    /cookieStore\.set\(SPC_USER_COOKIE_NAME,\s*"",\s*options\)/,
  )
  assert.match(
    setSession,
    /cookieStore\.set\([\s\S]*?SPC_COOKIE_NAME,[\s\S]*?session\.token,[\s\S]*?cookieOptions\(session\.expiresAt\)/,
  )
  assert.match(
    setSession,
    /cookieStore\.set\(SPC_USER_COOKIE_NAME,\s*"",\s*expiredCookieOptions\(\)\)/,
  )
  assert.match(clearSession, /finally\s*\{\s*clearSpcCookies\(cookieStore\)/)
  assert.match(refreshedSession, /resolveSpcSession\(true\)/)
})

test("the SPC session endpoint refreshes the persistent cookie", () => {
  const route = readFileSync(
    new URL("../app/api/spc/session/route.ts", import.meta.url),
    "utf8",
  )
  const resolver = sourceBetween(
    "async function resolveSpcSession",
    "export async function getSpcSession",
  )

  assert.match(route, /getRefreshedSpcSession/)
  assert.match(route, /await getRefreshedSpcSession\(\)/)
  assert.match(
    resolver,
    /if \(refreshCookie\)[\s\S]*?cookieStore\.set\([\s\S]*?SPC_COOKIE_NAME,[\s\S]*?token,[\s\S]*?cookieOptions\(databaseSession\.expiresAt\)/,
  )
})

test("active SPC browser sessions periodically revisit the cookie-refresh endpoint", () => {
  const clientAuth = readFileSync(
    new URL("../lib/useSpcAuth.ts", import.meta.url),
    "utf8",
  )

  assert.match(clientAuth, /SPC_SESSION_BACKGROUND_REFRESH_MS = 12 \* 60 \* 60 \* 1000/)
  assert.match(clientAuth, /window\.addEventListener\("focus", refreshActiveSession\)/)
  assert.match(clientAuth, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/)
  assert.match(clientAuth, /window\.setInterval\([\s\S]*?refreshActiveSession,[\s\S]*?SPC_SESSION_BACKGROUND_REFRESH_MS/)
  assert.match(clientAuth, /window\.clearInterval\(refreshInterval\)/)
  assert.match(clientAuth, /fetch\("\/api\/spc\/session", \{ cache: "no-store" \}\)/)
})
