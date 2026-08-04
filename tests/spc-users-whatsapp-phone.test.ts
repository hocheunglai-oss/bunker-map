import assert from "node:assert/strict"
import test from "node:test"
import { normaliseSpcWhatsappPhone, normaliseSpcWhatsappPhoneInput } from "../lib/spcUsers"

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
