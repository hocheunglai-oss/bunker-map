import assert from "node:assert/strict"
import test from "node:test"
import {
  normaliseSpcWhatsappPhone,
  normaliseSpcWhatsappPhoneForAccount,
  normaliseSpcWhatsappPhoneInput,
} from "../lib/spcUsers"

test("normalizes SPC WhatsApp phone numbers to E.164 digits", () => {
  assert.equal(normaliseSpcWhatsappPhone("+65 9145 6766"), "6591456766")
  assert.equal(normaliseSpcWhatsappPhone("0039 340 075 2786"), "393400752786")
  assert.equal(normaliseSpcWhatsappPhone(""), "")
})

test("rejects local or invalid SPC WhatsApp phone numbers", () => {
  assert.throws(
    () => normaliseSpcWhatsappPhoneInput("6688 5575"),
    /include the country code/i,
  )
  assert.throws(
    () => normaliseSpcWhatsappPhoneInput("not a phone"),
    /include the country code/i,
  )
})

test("requires a WhatsApp phone for active SPC accounts only", () => {
  assert.equal(
    normaliseSpcWhatsappPhoneForAccount("+86 139 5012 5136", true),
    "8613950125136",
  )
  assert.equal(normaliseSpcWhatsappPhoneForAccount("", false), "")
  assert.throws(
    () => normaliseSpcWhatsappPhoneForAccount("", true),
    /required for an active SPC account/i,
  )
})

test("SPC User Management marks an active account phone as required", async () => {
  const { readFile } = await import("node:fs/promises")
  const page = await readFile(
    new URL("../app/spc/usermanagement/page.tsx", import.meta.url),
    "utf8",
  )

  assert.match(page, /WhatsApp Phone\{userDraft\.isActive \? " \*" : ""\}/)
  assert.match(page, /required=\{userDraft\.isActive\}/)
})
