// Actual auth provider/route guard and Phonebook page; synthetic session/data only.
import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import { AdminRouteGuard } from "../../components/AdminRouteGuard"
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"
import { primeAdminClientSessionCache, SimpleAdminAuthProvider } from "../../lib/useSimpleAdminAuth"
import Phonebook from "../../app/admin/phonebook/page"
import { installPhonebookSyncHarness } from "./phonebook-sync-mocks"

type Mode = "view" | "edit" | "none" | "signed-out"
const fixture = {
  desired: { busy: true, idle: false },
  clicks: 0,
  safeClicks: 0,
  navClicks: 0,
  observerCallbacks: 0,
  requests: [] as { method: string; path: string }[],
  forwardedWrites: [] as string[],
  setMode: (() => {}) as (mode: Mode) => void,
  route: (() => {}) as (path: string) => void,
}
const browser = window as typeof window & { __adminViewControlState: typeof fixture }
browser.__adminViewControlState = fixture
const variant = new URLSearchParams(location.search).get("variant")
const NativeObserver = window.MutationObserver
window.MutationObserver = class extends NativeObserver {
  constructor(callback: MutationCallback) {
    super((records, observer) => {
      fixture.observerCallbacks += 1
      callback(records, observer)
    })
  }
}

function session(mode: Mode) {
  return mode === "signed-out" ? { authenticated: false } : {
    authenticated: true,
    username: "view-control@example.invalid",
    displayName: "Synthetic View Control",
    actorKey: "a".repeat(64),
    role: "USER",
    resetRequired: false,
    mustChangePassword: false,
    permissions: { phonebook: mode },
    pages: ADMIN_PAGE_DEFINITIONS,
  }
}
let mode: Mode = "view"
if (variant === "phonebook") installPhonebookSyncHarness()
const syntheticPageFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase()
  if (url.origin !== location.origin) throw new Error("External fixture request forbidden")
  fixture.requests.push({ method, path: url.pathname })
  if (method === "GET" && url.pathname === "/api/admin/session") return Response.json(session(mode))
  if (url.pathname === "/api/admin/view-control-probe") {
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) fixture.forwardedWrites.push(method)
    return Response.json({ syntheticOnly: true })
  }
  if (variant === "phonebook" && method === "GET") return syntheticPageFetch(input, init)
  throw new Error(`Unexpected fixture request ${method} ${url.pathname}`)
}
fixture.setMode = next => { mode = next; primeAdminClientSessionCache(session(next)) }
fixture.route = next => {
  history.replaceState(null, "", next + "?variant=" + variant)
  window.dispatchEvent(new Event("fixture-route"))
}

function Controls() {
  const [state, setState] = useState(fixture.desired)
  const [rows, setRows] = useState(0)
  function update(busy: boolean, idle: boolean) {
    fixture.desired = { busy, idle }
    setState(fixture.desired)
  }
  return <main>
    <h1>View control state</h1>
    <div data-admin-view-safe="true">
      <button onClick={() => update(false, true)}>Finish loading</button>
      <button onClick={() => update(true, false)}>Start loading</button>
      <button onClick={() => setRows(value => value + 1)}>Append row</button>
      <button onClick={() => { update(false, true); fixture.route("/admin") }}>Finish and leave View</button>
      <button onClick={() => { fixture.safeClicks += 1 }}>Save safe fixture</button>
      <select aria-label="Safe filter" defaultValue="a"><option value="a">A</option><option value="b">B</option></select>
    </div>
    <button className="fc-admin-nav-button" onClick={() => { fixture.navClicks += 1 }}>Edit navigation fixture</button>
    <input aria-label="Search fixture" />
    <button id="busy-button" disabled={state.busy} onClick={() => { fixture.clicks += 1 }}>Edit busy fixture</button>
    <button id="idle-button" disabled={state.idle} onClick={() => { fixture.clicks += 1 }}>Save idle fixture</button>
    <button id="always-busy" disabled onClick={() => { fixture.clicks += 1 }}>Delete busy fixture</button>
    <select id="busy-select" aria-label="Unsafe select" disabled={state.busy} defaultValue="a"><option value="a">A</option><option value="b">B</option></select>
    {(["checkbox", "radio", "file", "range", "color"] as const).map(type => <input key={type} id={"busy-" + type} aria-label={"Unsafe " + type} type={type} disabled={state.busy} />)}
    <input id="busy-input" aria-label="Unsafe text" readOnly={state.busy} defaultValue="Original input" />
    <textarea id="busy-textarea" aria-label="Unsafe textarea" readOnly={state.busy} defaultValue="Original textarea" />
    <input id="idle-input" aria-label="Idle text" readOnly={state.idle} defaultValue="Idle input" />
    <textarea id="idle-textarea" aria-label="Idle textarea" readOnly={state.idle} defaultValue="Idle textarea" />
    <input id="always-readonly" aria-label="Always readonly" readOnly defaultValue="Always readonly" />
    {Array.from({ length: rows }, (_, index) => <span key={index}>Row {index + 1}</span>)}
  </main>
}

createRoot(document.getElementById("root")!).render(
  <div className="fc-admin-scope"><SimpleAdminAuthProvider><AdminRouteGuard>
    {variant === "phonebook" ? <Phonebook key="page" /> : <Controls key="controls" />}
  </AdminRouteGuard></SimpleAdminAuthProvider></div>,
)
