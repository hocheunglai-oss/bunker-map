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
      exactGroupName: "",
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
      exactGroupName: "",
    },
  ])
})

test("resolves Otto, Vincent, and Stanley to their exact active delivery groups", () => {
  const users = [
    { username: "otto@cosulich.com.hk", display_name: "OTTO LAI", whatsapp_phone: "+852 6688 5575", delivery_route_id: "route-otto" },
    { username: "vincent@cosulich.com.hk", display_name: "VINCENT LEE", whatsapp_phone: "+852 6688 5573", delivery_route_id: "route-vincent" },
    { username: "stanley@cosulich.com.hk", display_name: "STANLEY CHUI", whatsapp_phone: "+852 6688 5572", delivery_route_id: "route-stanley" },
  ]
  const routes = [
    { id: "route-otto", exact_group_name: "Otto (FCBHK) SG Enqs", is_active: true },
    { id: "route-vincent", exact_group_name: "Vincent (FCBHK) SG Enqs", is_active: true },
    { id: "route-stanley", exact_group_name: "Stanley (FCBHK) SG Enqs", is_active: true },
  ]

  assert.deepEqual(
    resolveSpcEnquiryChatContacts(users, [], routes).map(({ displayName, exactGroupName }) => ({
      displayName,
      exactGroupName,
    })),
    [
      { displayName: "OTTO LAI", exactGroupName: "Otto (FCBHK) SG Enqs" },
      { displayName: "VINCENT LEE", exactGroupName: "Vincent (FCBHK) SG Enqs" },
      { displayName: "STANLEY CHUI", exactGroupName: "Stanley (FCBHK) SG Enqs" },
    ],
  )
})

test("does not expose an inactive delivery group as a reply route", () => {
  const result = resolveSpcEnquiryChatContacts(
    [{ username: "vincent@cosulich.com.hk", display_name: "VINCENT LEE", whatsapp_phone: "+852 6688 5573", delivery_route_id: "route-vincent" }],
    [],
    [{ id: "route-vincent", exact_group_name: "Vincent (FCBHK) SG Enqs", is_active: false }],
  )

  assert.equal(result[0].exactGroupName, "")
})
