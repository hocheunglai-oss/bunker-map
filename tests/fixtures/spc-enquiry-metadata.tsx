import React from "react"
import { createRoot } from "react-dom/client"
import Enquiries from "../../app/spc/enquiries/page"
import { SpcAuthProvider } from "../../lib/useSpcAuth"

// Actual page, auth provider/session parser, shell and deterministic parser.
// Only the fixture's GET-only session/bootstrap/history responses are synthetic.
const mode = new URL(location.href).searchParams.get("mode") || "edit"
if (!["edit", "view", "none", "signed-out"].includes(mode)) throw Error("Unknown fixture permission")
const username = "synthetic-buyer@example.invalid"
const harness = {
  mode, requests: [] as { path: string; method: string }[],
  forbidden: [] as string[], routes: [] as string[], messages: [] as unknown[],
}
declare global { interface Window { __spcMetadata: typeof harness } }
window.__spcMetadata = harness
window.addEventListener("message", event => harness.messages.push(event.data))
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase()
  harness.requests.push({ path: url.pathname + url.search, method })
  function deny(): never {
    harness.forbidden.push(method + " " + url.pathname + url.search)
    throw Error("Forbidden synthetic enquiry request")
  }
  if (url.origin !== location.origin || method !== "GET") return deny()
  if (url.pathname === "/api/spc/session" && !url.search) {
    if (mode === "signed-out") return Response.json({ authenticated: false })
    return Response.json({
      authenticated: true, actorKey: "a".repeat(64), username, displayName: "Synthetic Buyer",
      role: "BUYER TRADER", office: "SINGAPORE", mustChangePassword: false,
      permissions: { "spc-buyer-enquiries": mode },
      pages: [{ id: "spc-buyer-enquiries", label: "NEW ENQUIRY", group: "trading", path: "/spc/enquiries" }],
    })
  }
  if (mode !== "edit" && mode !== "view") return deny()
  if (url.pathname === "/api/spc/enquiries" && url.search === "?limit=200&bootstrap=1") {
    return Response.json({ enquiries: [], supplierTraders: [], buyerLostReasons: ["SYNTHETIC REASON"], sessionKey: username })
  }
  if (url.pathname === "/api/spc/enquiry-history") {
    const keys = [...url.searchParams.keys()].sort()
    if (keys.join(",") !== "imo,vesselName" || (url.searchParams.get("vesselName") || "").length > 250 || !/^\d{0,7}$/.test(url.searchParams.get("imo") || "")) return deny()
    return Response.json({ fixed: [], lost: [], visibility: { fixtures: false, lost: false } })
  }
  return deny()
}
createRoot(document.getElementById("root")!).render(
  <div className="fc-admin-scope spc-scope"><SpcAuthProvider><Enquiries /></SpcAuthProvider></div>,
)
