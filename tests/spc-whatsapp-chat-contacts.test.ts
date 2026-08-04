import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeRequestedSpcWhatsappChatNames,
  resolveSpcWhatsappChatContacts,
} from "../lib/spcWhatsappChatContacts"

const baseContact = {
  mobile_area: null,
  mobile_1: null,
  mobile_2: null,
  mobile_phone: null,
  direct_line: null,
  business_phone: null,
  business_phone_2: null,
  other_phone: null,
}

test("normalizes and de-duplicates saved WhatsApp chat names", () => {
  assert.deepEqual(
    normalizeRequestedSpcWhatsappChatNames([" MICHELLE  ANTHONEY ", "michelle anthoney", "KOREA"]),
    [
      { name: "MICHELLE ANTHONEY", lookupName: "michelle anthoney" },
      { name: "KOREA", lookupName: "korea" },
    ],
  )
})

test("returns a phone only for one exact normalized name and phone", () => {
  assert.deepEqual(
    resolveSpcWhatsappChatContacts(
      ["MICHELLE  ANTHONEY", "KOREA", "AMBIGUOUS CONTACT"],
      [
        {
          ...baseContact,
          id: "michelle",
          full_name: "MICHELLE ANTHONEY",
          mobile_1: "+65-96791141",
        },
        {
          ...baseContact,
          id: "ambiguous-a",
          full_name: "AMBIGUOUS CONTACT",
          mobile_1: "+65-90000001",
        },
        {
          ...baseContact,
          id: "ambiguous-b",
          full_name: "AMBIGUOUS CONTACT",
          mobile_1: "+65-90000002",
        },
      ],
    ),
    [{ name: "MICHELLE ANTHONEY", phone: "6596791141", phonebookContactId: "michelle" }],
  )
})

test("accepts duplicate phonebook rows only when they resolve to the same phone", () => {
  assert.deepEqual(
    resolveSpcWhatsappChatContacts(
      ["MICHELLE ANTHONEY"],
      [
        { ...baseContact, id: "first", full_name: "MICHELLE ANTHONEY", mobile_1: "+65 9679 1141" },
        { ...baseContact, id: "second", full_name: "MICHELLE ANTHONEY", mobile_phone: "6596791141" },
      ],
    ),
    [{ name: "MICHELLE ANTHONEY", phone: "6596791141", phonebookContactId: "first" }],
  )
})
