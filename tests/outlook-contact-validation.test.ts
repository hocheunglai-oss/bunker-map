import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import {
  normalizeOutlookContactFields,
  validateOutlookContactFields,
  type OutlookContactFields,
} from "../lib/outlookContactValidation"

const contact: OutlookContactFields = {
  display_name: "DORVAL-NATSUMI SUDA",
  primary_email: "n.suda@example.com",
  source_book: "FC-GENERAL",
  nickname: null,
  first_name: "Natsumi",
  last_name: "Suda",
}

test("contact normalization is limited to editable fields and does not repair an incomplete email", () => {
  assert.deepEqual(normalizeOutlookContactFields({
    ...contact,
    display_name: "  DORVAL-  NATSUMI\nSUDA  ",
    primary_email: "  N.SUDA@EXAMPLE.COM ",
    source_book: "  FC-GENERAL  ",
    nickname: "  ",
    first_name: " Natsumi ",
    last_name: "  Van   Suda  ",
  }), {
    display_name: "DORVAL- NATSUMI SUDA",
    primary_email: "n.suda@example.com",
    source_book: "FC-GENERAL",
    nickname: null,
    first_name: "Natsumi",
    last_name: "Van Suda",
  })
  assert.equal(normalizeOutlookContactFields({ ...contact, primary_email: " n. suda@example.com " }).primary_email, "n. suda@example.com")
})

test("complete contacts accept standard business email variants", () => {
  for (const primary_email of ["n.suda@example.com", "n.suda+orders@sub.example.com", "o'brien@example.co.jp", "N.SUDA@EXAMPLE.COM"]) {
    assert.equal(validateOutlookContactFields({ ...contact, primary_email }), null, primary_email)
  }
})

test("blank, incomplete, malformed, multiple and whitespace-containing email addresses are rejected", () => {
  for (const primary_email of [
    "", " ", "n.suda", "n.suda@", "@example.com", "n.suda@example", "n. suda@example.com",
    "n.suda@exam ple.com", "n.suda@example.com,n.suda@example.jp", "n.suda@example.com;other@example.com",
    "Natsumi <n.suda@example.com>", "n.suda@@example.com", "n.suda@.example.com", "n.suda@example..com",
    "n.suda@-example.com", "n.suda@example-.com", ".n.suda@example.com", "n.suda.@example.com",
    "n..suda@example.com", "n.suda\nother@example.com", `${"a".repeat(65)}@example.com`,
  ]) {
    assert.match(validateOutlookContactFields({ ...contact, primary_email }) || "", /valid email address/, JSON.stringify(primary_email))
    assert.match(validateOutlookContactFields({ primary_email }, "update") || "", /valid email address/, JSON.stringify(primary_email))
  }
})

test("creating a contact requires name, source book and email", () => {
  assert.equal(validateOutlookContactFields({}), "Display name is required.")
  assert.equal(validateOutlookContactFields({ ...contact, display_name: " \n " }), "Display name is required.")
  assert.equal(validateOutlookContactFields({ ...contact, source_book: " " }), "Source book is required.")
  assert.match(validateOutlookContactFields({ display_name: "Test", source_book: "FC-GENERAL" }) || "", /valid email address/)
})

test("partial updates validate supplied fields without requiring untouched legacy fields", () => {
  assert.equal(validateOutlookContactFields({ first_name: "Natsumi" }, "update"), null)
  assert.equal(validateOutlookContactFields({ nickname: null }, "update"), null)
  assert.equal(validateOutlookContactFields({ primary_email: contact.primary_email }, "update"), null)
  assert.equal(validateOutlookContactFields({ display_name: "" }, "update"), "Display name is required.")
  assert.equal(validateOutlookContactFields({ source_book: "" }, "update"), "Source book is required.")
})

test("runtime type mismatches are rejected instead of coercing invalid fields", () => {
  assert.match(validateOutlookContactFields({ ...contact, primary_email: null } as unknown as OutlookContactFields) || "", /valid email address/)
  assert.equal(validateOutlookContactFields({ display_name: 123 } as unknown as OutlookContactFields, "update"), "Display name is required.")
  assert.equal(validateOutlookContactFields({ nickname: {} } as unknown as OutlookContactFields, "update"), "Contact names must be text.")
})

const routeSource = readFileSync(new URL("../app/api/admin/supabase/route.ts", import.meta.url), "utf8")
const routeOutput = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText

type Handler = (request: Request) => Promise<Response>
type ForwardedRequest = { target: string; headers: Headers; method: string; body: string | undefined }

function loadRoute(permissionError?: "Unauthorized" | "Forbidden") {
  const forwarded: ForwardedRequest[] = []
  const permissions: Array<{ page: string; permission: string }> = []
  const exports: Record<string, Handler> = {}
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@supabase/supabase-js": { createClient: () => { throw new Error("Unexpected Supabase client: no real database access is allowed in this test.") } },
    "@/lib/outlookContactValidation": { validateOutlookContactFields },
    "@/lib/adminAuth": { requireAdminPagePermission: async (page: string, permission: string) => {
      permissions.push({ page, permission })
      if (permissionError) throw new Error(permissionError)
      return { username: "test-admin", displayName: "Test Admin", role: "ADMIN" }
    } },
  }
  vm.runInNewContext(routeOutput, {
    exports,
    Error,
    URL,
    Headers,
    TextDecoder,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://contact-fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-live-key" } },
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    fetch: async (target: URL, options: { method: string; headers: Headers; body?: ArrayBuffer }) => {
      assert.equal(target.origin, "https://contact-fixture.invalid")
      forwarded.push({ target: target.href, method: options.method, headers: options.headers, body: options.body ? new TextDecoder().decode(options.body) : undefined })
      return Response.json([{ id: "existing-contact" }])
    },
  })
  return { exports, forwarded, permissions }
}

function request(method: string, payload?: unknown, table = "shared_addressbook_contacts", page = "outlook-addressbook") {
  const target = `https://contact-fixture.invalid/rest/v1/${table}?id=eq.existing-contact`
  return new Request(`https://app-fixture.invalid/api/admin/supabase?target=${encodeURIComponent(target)}`, {
    method,
    headers: { "content-type": "application/json", "x-bunker-admin-page-id": page, "x-bunker-admin-user": "forged-user" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
}

test("server rejects the exact cleared-email regression before forwarding any mutation", async () => {
  const { exports, forwarded, permissions } = loadRoute()
  const response = await exports.PATCH(request("PATCH", { display_name: contact.display_name, primary_email: "" }))
  assert.equal(response.status, 400)
  assert.match((await response.json()).message, /valid email address/)
  assert.equal(forwarded.length, 0)
  assert.deepEqual(permissions, [{ page: "outlook-addressbook", permission: "edit" }])
})

test("server forwards a valid atomic update with the original identity filter and trusted audit actor", async () => {
  const { exports, forwarded } = loadRoute()
  const response = await exports.PATCH(request("PATCH", contact))
  assert.equal(response.status, 200)
  assert.equal(forwarded.length, 1)
  assert.equal(new URL(forwarded[0].target).searchParams.get("id"), "eq.existing-contact")
  assert.equal(forwarded[0].method, "PATCH")
  assert.deepEqual(JSON.parse(forwarded[0].body!), contact)
  assert.equal(forwarded[0].headers.get("x-bunker-admin-user"), "test-admin")
  assert.equal(forwarded[0].headers.get("x-bunker-admin-page-id"), "outlook-addressbook")
})

test("server permits updates that leave existing unsupplied fields untouched", async () => {
  const { exports, forwarded } = loadRoute()
  const response = await exports.PATCH(request("PATCH", { nickname: null }))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(forwarded[0].body!), { nickname: null })
})

test("server validates every create row before forwarding the batch", async () => {
  const { exports, forwarded } = loadRoute()
  const response = await exports.POST(request("POST", [contact, { ...contact, primary_email: "incomplete@" }]))
  assert.equal(response.status, 400)
  assert.equal(forwarded.length, 0)
})

test("server accepts a complete create while preserving source-card and other non-editable data", async () => {
  const { exports, forwarded } = loadRoute()
  const payload = { ...contact, id: "new-contact", source_card: "card-id", properties: { preserved: true } }
  const response = await exports.POST(request("POST", payload))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(forwarded[0].body!), payload)
})

test("server rejects invalid JSON shapes and empty create bodies with no mutation", async () => {
  for (const [method, payload] of [["POST", null], ["POST", []], ["POST", "text"], ["POST", {}], ["PATCH", []], ["PATCH", { primary_email: 123 }]] as const) {
    const { exports, forwarded } = loadRoute()
    assert.equal((await exports[method](request(method, payload))).status, 400)
    assert.equal(forwarded.length, 0)
  }
  const { exports, forwarded } = loadRoute()
  assert.equal((await exports.POST(request("POST"))).status, 400)
  const malformed = request("POST", contact)
  const rawRequest = new Request(malformed.url, { method: "POST", headers: malformed.headers, body: "{" })
  assert.equal((await exports.POST(rawRequest)).status, 400)
  assert.equal(forwarded.length, 0)
})

test("authorization runs before validation and rejects unauthorized and view-only users", async () => {
  for (const [message, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const { exports, forwarded } = loadRoute(message)
    const response = await exports.PATCH(request("PATCH", { primary_email: "" }))
    assert.equal(response.status, status)
    assert.equal((await response.json()).message, message)
    assert.equal(forwarded.length, 0)
  }
})

test("the existing page-table scope still rejects an unrelated page before forwarding", async () => {
  const { exports, forwarded, permissions } = loadRoute()
  const response = await exports.PATCH(request("PATCH", contact, "shared_addressbook_contacts", "phonebook"))
  assert.equal(response.status, 403)
  assert.equal(forwarded.length, 0)
  assert.equal(permissions.length, 0)
})

test("contact reads, deletes and unrelated group writes are not treated as contact edits", async () => {
  for (const method of ["GET", "DELETE"]) {
    const { exports, forwarded } = loadRoute()
    assert.equal((await exports[method](request(method))).status, 200)
    assert.equal(forwarded.length, 1)
  }
  const { exports, forwarded } = loadRoute()
  assert.equal((await exports.PATCH(request("PATCH", { name: "Group" }, "shared_addressbook_groups"))).status, 200)
  assert.equal(forwarded.length, 1)
})
