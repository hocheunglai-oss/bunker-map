import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeRequestedSpcChatUsernames,
  normalizeWhatsappPhone,
  resolveSpcEnquiryChatContacts,
} from "../lib/spcEnquiryChatContacts"

test("normalizes and limits requested SPC usernames", () => {
  assert.deepEqual(
    normalizeRequestedSpcChatUsernames([" BARRY@COSULICH.COM.SG ", "bad", "barry@cosulich.com.sg"]),
    ["barry@cosulich.com.sg"],
  )
})

test("normalizes international and known-office local phone numbers", () => {
  assert.equal(normalizeWhatsappPhone("+65-9145 6766", "barry@cosulich.com.sg"), "6591456766")
  assert.equal(normalizeWhatsappPhone("6688 5575", "otto@cosulich.com.hk"), "85266885575")
  assert.equal(normalizeWhatsappPhone("06 1234 5678", "person@cosulich.it"), "39612345678")
  assert.equal(normalizeWhatsappPhone("123", "person@cosulich.com"), "")
})

test("resolves only one exact phonebook email match", () => {
  const users = [
    { username: "barry@cosulich.com.sg", display_name: "BARRY KHOO", whatsapp_phone: null },
    { username: "duplicate@cosulich.com.sg", display_name: "DUPLICATE", whatsapp_phone: null },
  ]
  const base = {
    full_name: "BARRY KHOO",
    mobile_area: null,
    mobile_2: null,
    mobile_phone: null,
    direct_line: null,
    business_phone: null,
    business_phone_2: null,
    other_phone: null,
    general_email: null,
    private_email: null,
    email_1: null,
    email_2: null,
  }
  const contacts = [
    { ...base, id: "barry", mobile_1: "+65 9145 6766", personal_email: "barry@cosulich.com.sg" },
    { ...base, id: "duplicate-1", mobile_1: "+65 9000 0001", personal_email: "duplicate@cosulich.com.sg" },
    { ...base, id: "duplicate-2", mobile_1: "+65 9000 0002", personal_email: "duplicate@cosulich.com.sg" },
  ]

  assert.deepEqual(resolveSpcEnquiryChatContacts(users, contacts), [
    {
      username: "barry@cosulich.com.sg",
      displayName: "BARRY KHOO",
      phone: "6591456766",
      phonebookContactId: "barry",
    },
  ])
})

test("uses the verified SPC user WhatsApp phone before phonebook fallback", () => {
  const users = [{
    username: "barry@cosulich.com.sg",
    display_name: "BARRY KHOO",
    whatsapp_phone: "6591456766",
  }]

  assert.deepEqual(resolveSpcEnquiryChatContacts(users, []), [
    {
      username: "barry@cosulich.com.sg",
      displayName: "BARRY KHOO",
      phone: "6591456766",
      phonebookContactId: "",
    },
  ])
})
