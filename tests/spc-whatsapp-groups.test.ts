import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { createSpcWhatsappApiGroup, normalizeSpcWhatsappGroupSubject } from "@/lib/spcWhatsappGroups"

const config = {
  graphVersion: "v26.0",
  phoneNumberId: "123456789",
  accessToken: "test-token",
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

test("official group creation resolves the Meta group ID and invite link", async () => {
  const calls: Array<{ url: string; method: string; body: string }> = []
  const responses = [
    jsonResponse({ data: { groups: [] } }),
    jsonResponse({ success: true }),
    jsonResponse({ data: { groups: [{ id: "group-1", subject: "OTTO LAI (SPC)", created_at: "1776660000" }] } }),
    jsonResponse({ messaging_product: "whatsapp", invite_link: "https://chat.whatsapp.com/TestInvite123" }),
  ]
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method || "GET", body: String(init?.body || "") })
    const response = responses.shift()
    if (!response) throw new Error("Unexpected request")
    return response
  }) as typeof fetch

  const group = await createSpcWhatsappApiGroup("  OTTO   LAI (SPC) ", {
    config,
    fetchImpl,
    wait: async () => undefined,
  })

  assert.deepEqual(group, {
    id: "group-1",
    subject: "OTTO LAI (SPC)",
    createdAt: "1776660000",
    inviteLink: "https://chat.whatsapp.com/TestInvite123",
    reused: false,
  })
  assert.equal(calls[1].method, "POST")
  assert.match(calls[1].body, /"subject":"OTTO LAI \(SPC\)"/)
  assert.match(calls[3].url, /group-1\/invite_link$/)
})

test("an existing exact group is reused instead of duplicated", async () => {
  const methods: string[] = []
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method || "GET")
    return methods.length === 1
      ? jsonResponse({ data: { groups: [{ id: "existing", subject: "OTTO LAI (SPC)", created_at: "1" }] } })
      : jsonResponse({ messaging_product: "whatsapp", invite_link: "https://chat.whatsapp.com/Existing123" })
  }) as typeof fetch

  const group = await createSpcWhatsappApiGroup("OTTO LAI (SPC)", { config, fetchImpl })
  assert.equal(group.reused, true)
  assert.deepEqual(methods, ["GET", "GET"])
})

test("group subjects are normalized and constrained", () => {
  assert.equal(normalizeSpcWhatsappGroupSubject(" A   TEST "), "A TEST")
  assert.throws(() => normalizeSpcWhatsappGroupSubject(""), /required/)
  assert.throws(() => normalizeSpcWhatsappGroupSubject("x".repeat(129)), /128/)
})

test("the pilot route is edit-protected and audited without the invite link", async () => {
  const route = await readFile(new URL("../app/api/spc/whatsapp-groups/route.ts", import.meta.url), "utf8")
  assert.match(route, /requireSpcPagePermission\("spc-chrome-extension", "edit"\)/)
  assert.match(route, /table_name: "spc_whatsapp_groups"/)
  assert.match(route, /Do not create it again/)
  assert.doesNotMatch(route, /after_row:[\s\S]{0,400}inviteLink/)
})

test("the pilot page uses inline two-step confirmation instead of a browser dialog", async () => {
  const page = await readFile(new URL("../app/spc/chrome/page.tsx", import.meta.url), "utf8")
  const createFunction = page.slice(
    page.indexOf("async function createApiGroup"),
    page.indexOf("if (authLoading", page.indexOf("async function createApiGroup")),
  )
  assert.match(page, /Confirm Create/)
  assert.doesNotMatch(createFunction, /window\.confirm/)
})
