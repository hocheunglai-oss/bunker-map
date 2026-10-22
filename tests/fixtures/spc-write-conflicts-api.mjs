import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { createSupplierRoute } from "./spc-supplier-api.mjs"
import { createSpcStemRoute, enquiry, expectedVersion, stemPayload, session, users } from "./spc-stem-api.mjs"

// These independent expected tuples are also used by the native guard tests.
export const cases = [
  ["supplier", "Supplier data changed. Reload and retry the save.", "supplier-store-cas-contention", "supplier-store-cas-contention", "conflict"],
  ["supplier", "Supplier data was not saved.", "supplier-store-write-unconfirmed", null, "unconfirmed"],
  ["supplier", "Supplier audit was not saved. No changes were applied.", "supplier-store-write-unconfirmed", null, "unconfirmed"],
  ["stem", "This STEM request no longer matches the saved enquiry. Refresh and try again.", "SPC_STEM_CONFLICT", null, "conflict"],
  ["stem", "The fixture for this STEM is no longer available. Refresh and ask an administrator to review it.", "SPC_STEM_CONFLICT", null, "conflict"],
  ["stem", "This enquiry changed while you were editing. Refresh and try again.", "SPC_STEM_CONFLICT", null, "conflict"],
  ["stem", "This enquiry already has a fixture. Refresh and ask an administrator to review it.", "SPC_STEM_CONFLICT", null, "conflict"],
  ["stem", "The STEM enquiry was not saved. Refresh and review before trying again.", "SPC_STEM_UNCONFIRMED", null, "unconfirmed"],
  ["stem", "The STEM fixture was not created. Your enquiry was not changed. Refresh and try again.", "SPC_STEM_UNCONFIRMED", null, "unconfirmed"],
  ["fixture", "This fixture is no longer available. Refresh and try again.", "SPC_FIXTURE_CONFLICT", null, "conflict"],
  ["fixture", "This fixture changed while you were editing. Your draft was not saved. Refresh and review the latest fixture.", "SPC_FIXTURE_CONFLICT", null, "conflict"],
  ["fixture", "The fixture was not deleted. Refresh and review the latest fixture.", "SPC_FIXTURE_UNCONFIRMED", null, "unconfirmed"],
  ["fixture", "The fixture was not saved. Refresh and review the latest fixture.", "SPC_FIXTURE_UNCONFIRMED", null, "unconfirmed"],
  ["fixture", "The fixture supplier could not be synchronized. Your draft was not saved. Refresh and try again.", "SPC_FIXTURE_UNCONFIRMED", null, "unconfirmed"],
]

export function sdkWriteHarness(domain, error, options = {}) {
  let posts = 0, reads = 0
  const headersSeen = []
  const rpc = { supplier: "compare_and_swap_spc_supplier_store", stem: "stem_spc_enquiry_with_fixture", fixture: "update_spc_fixture_with_enquiry" }[domain]
  const client = headers => {
    headersSeen.push(headers)
    return createClient("https://synthetic.invalid", "synthetic-only-never-remote", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers, fetch: async (input, init = {}) => {
        const url = new URL(String(input)); assert.equal(url.origin, "https://synthetic.invalid")
        const method = init.method || "GET"
        if (method === "GET") {
          reads++
          if (url.pathname === "/rest/v1/spc_enquiries") return Response.json(structuredClone(enquiry))
          assert.ok(["/rest/v1/office_calendar_store", "/rest/v1/spc_fixtures"].includes(url.pathname), url.pathname)
          return Response.json([])
        }
        assert.equal(method, "POST"); assert.equal(url.pathname, `/rest/v1/rpc/${rpc}`); posts++
        const args = JSON.parse(init.body)
        const injected = typeof error === "function" ? error(posts) : error
        if (injected) return Response.json({ hint: null, details: null, ...injected }, { status: 400 })
        if (domain === "supplier") return Response.json({ schema: "fcuno.supplier-store-cas/v1", requestId: args.p_request_id, payload: args.p_payload, updatedAt: expectedVersion })
        if (domain === "stem") return Response.json([{ ...enquiry, status: "quoted", notes: args.p_notes, stem_request_id: args.p_request_id, stem_source_updated_at: args.p_expected_updated_at, stem_supplier_username: args.p_supplier_username }])
        return Response.json({ id: args.p_fixture_id })
      } },
    })
  }
  const actor = domain === "fixture" ? { ...session, username: users[1].username, displayName: users[1].displayName, userId: users[1].id, role: "SUPPLIER TRADER" } : session
  const app = domain === "supplier" ? createSupplierRoute({ createClient: client, ...options })
    : createSpcStemRoute({ createClient: client, actor, fixtureRoute: domain === "fixture", ...options })
  return {
    posts: () => posts, reads: () => reads, headers: () => headersSeen,
    async patch() {
      if (domain === "stem") return app.patch(stemPayload())
      if (domain === "fixture") return app.patch({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", action: "delete", expectedUpdatedAt: expectedVersion, expectedStatus: "completed" })
      const baseline = (await createSupplierRoute({ createClient: client }).get()).body.records.find(row => row.key === "SYNTHETICALPHA").editVersions
      return app.patch({ action: "save", supplier: { key: "SYNTHETICALPHA", name: "SYNTHETIC ALPHA", requestId: randomUUID(), expectedVersions: baseline,
        info: { paymentTerms: "30", qualityClaimBar: "", supplierTrader: "", availableGrade: "", foBdn: "", goBdn: "" } } })
    },
  }
}
