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
    /maxAge:\s*SPC_SESSION_DURATION_SECONDS/,
  )
  assert.match(persistentOptions, /expires:\s*new Date\(expiresAt\)/)
})

test("SPC cookie lifetime and clear paths remain complete", () => {
  const now = new Date("2026-08-07T04:00:00.000Z")
  const expiresAt = getSpcSessionExpiry(now)
  assert.equal(SPC_SESSION_DURATION_SECONDS, 12 * 60 * 60)
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
})
