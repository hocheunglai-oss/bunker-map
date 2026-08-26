import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { getSpcSessionPresentationLabel } from "../lib/spcSessionPresentation"

test("SPC administrators use their profile identity", () => {
  assert.equal(
    getSpcSessionPresentationLabel({
      role: "ADMIN",
      displayName: "OTTO LAI",
      username: "otto@cosulich.com.hk",
    }),
    "OTTO LAI",
  )
  assert.equal(
    getSpcSessionPresentationLabel({
      role: "administrator",
      displayName: "Another Admin",
      username: "admin@example.com",
    }),
    "Another Admin",
  )
})

test("SPC non-administrators retain their profile identity and username fallback", () => {
  assert.equal(
    getSpcSessionPresentationLabel({
      role: "BUYER TRADER",
      displayName: " MICHELLE ANTHONEY ",
      username: "michelle@cosulich.com.sg",
    }),
    "MICHELLE ANTHONEY",
  )
  assert.equal(
    getSpcSessionPresentationLabel({
      role: "SUPPLIER TRADER",
      displayName: "",
      username: " supplier@example.com ",
    }),
    "supplier@example.com",
  )
})

test("SPC welcome and shared navigation use the same presentation label", () => {
  const welcome = readFileSync(new URL("../app/spc/page.tsx", import.meta.url), "utf8")
  const navigation = readFileSync(
    new URL("../components/SpcNavigationShell.tsx", import.meta.url),
    "utf8",
  )

  assert.match(welcome, /WELCOME\{sessionPresentationLabel/)
  assert.match(
    welcome,
    /<Link href="\/spc\/presentation">[\s\S]*?PRESENTATION OF[\s\S]*?<br \/>[\s\S]*?INCORPORATE AI INTO TRADING[\s\S]*?<\/Link>/,
  )
  assert.match(welcome, /<Link href="\/spc\/enquiries">SEND ENQUIRY NOW<\/Link>/)
  assert.match(navigation, /title=\{sessionPresentationLabel \|\| "SPC"\}/)
  assert.match(navigation, /aria-label=\{`Signed in as \$\{sessionPresentationLabel \|\| "SPC"\}`\}/)
})
