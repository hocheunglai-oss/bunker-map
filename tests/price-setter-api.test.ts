import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"
import * as mutation from "../lib/priceSetterMutation"
import * as history from "../lib/priceHistoryRecords"
import * as settings from "../lib/priceSetterSettings"
import * as order from "../lib/priceSetterOrder"
import * as inventory from "../lib/priceSetterInventory"
import * as creationRecovery from "../lib/priceSetterCreationRecovery"
import * as priceRequest from "../lib/priceSetterRequest"

const id = "00000000-0000-4000-8000-000000000001"
const saved = { name: "Synthetic Port", lat: null, lng: null, hsfo: 600, vlsfo: 800, mgo: 1000, hsfo_formula: null, vlsfo_formula: null, mgo_formula: null, updated_at: "2026-10-08" }
const input = () => ({ portId: id, expected: { ...saved }, changes: mutation.buildPriceSetterChanges({ ...saved, hsfo: 0 }) })

function harness(options: { auth?: "Unauthorized" | "Forbidden"; serviceKey?: boolean; data?: unknown; error?: unknown; rpcThrow?: boolean; actorId?: string | null } = {}) {
  const events: string[] = [], calls: { name: string; args: Record<string, unknown> }[] = []
  const session = { userId: "synthetic-user", role: "BT", adminUserId: Object.hasOwn(options,"actorId") ? options.actorId : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
  const client = { async rpc(name: string, args: Record<string, unknown>) {
    events.push("rpc"); calls.push({ name, args })
    if (options.rpcThrow) throw new Error("PRIVATE database connection detail")
    const day = args.p_recorded_at ? history.getMarketDateKey(String(args.p_recorded_at)) : ""
    return { data: Object.hasOwn(options, "data") ? options.data : { replayed: false, ports: [{ id, ...saved, ...args.p_changes as object, updated_at: day }], history: { id: "synthetic-history", port_id: id, hsfo: 0, vlsfo: 800, mgo: 1000, recorded_at: `${day}T12:00:00` } }, error: options.error ?? null }
  } }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: { json: Response.json.bind(Response) } },
    "@/lib/priceSetterMutation": mutation,
    "@/lib/priceHistoryRecords": history,
    "@/lib/priceSetterSettings": settings,
    "@/lib/priceSetterOrder": order,
    "@/lib/priceSetterInventory": inventory,
    "@/lib/priceSetterCreationRecovery": creationRecovery,
    "@/lib/priceSetterRequest": priceRequest,
    "@/lib/adminAuth": { async requireAdminPagePermissionForRequest(request: Request, page: string, access: string) {
      events.push("auth"); assert.ok(request instanceof Request); assert.equal(page, "pricesetter"); assert.equal(access, request.method === "GET" ? "view" : "edit")
      if (options.auth) throw new Error(options.auth)
      return session
    } },
    "@/lib/adminAudit": {
      createAdminAuditContext(value: unknown, request: unknown, page: string) { events.push("audit"); assert.equal(value, session); assert.equal(request, undefined); assert.equal(page, "pricesetter"); return { userId: session.userId, page } },
      createAdminAuditedSupabaseClient(context: { page: string }, config: unknown) { events.push("client"); assert.equal(context.page, "pricesetter"); assert.deepEqual(config, { useServiceRole: true }); return client },
    },
  }
  const code = transformSync(readFileSync(new URL("../app/api/admin/prices/route.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs", target: "node24" }).code
  const loaded = { exports: {} as Record<"GET" | "PUT" | "POST" | "PATCH" | "DELETE", (request: Request) => Promise<Response>> }
  new Function("require", "module", "exports", "process", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency ${name}`)
    return modules[name]
  }, loaded, loaded.exports, { env: { SUPABASE_SERVICE_ROLE_KEY: options.serviceKey === false ? "" : "synthetic-only" } })
  return { calls, events, async request(body: unknown = input(), config: RequestInit = {}) {
    const request = new Request("https://example.test/api/admin/prices", { method: "POST", headers: { "Content-Type": "application/json", Referer: "https://example.test/admin/user-management" }, body: config.method === "GET" ? undefined : JSON.stringify(body), ...config })
    const response = await loaded.exports[request.method as "GET" | "PUT" | "POST" | "PATCH" | "DELETE"](request)
    return { status: response.status, body: await response.json(), headers: response.headers }
  } }
}

test("inventory GET requires View before privileged work, rejects incomplete reads, and never exposes private errors", async () => {
  const data = {version:1,count:1,ports:[{...saved,id,type:null,display_order:null}]}
  for (const auth of ["Unauthorized","Forbidden"] as const) {
    const app=harness({auth}),result=await app.request(null,{method:"GET"})
    assert.equal(result.status,auth==="Unauthorized"?401:403);assert.deepEqual(app.events,["auth"])
  }
  for(const data of [null,{},[],{version:1,count:1,ports:[]},{version:1,count:0,ports:[saved]}]) {
    assert.equal((await harness({data}).request(null,{method:"GET"})).status,503)
  }
  const app=harness({data}),result=await app.request(null,{method:"GET"})
  assert.equal(result.status,200);assert.deepEqual(result.body,data)
  assert.deepEqual(app.calls,[{name:"read_price_setter_inventory",args:{}}]);assert.deepEqual(app.events,["auth","audit","client","rpc"])
  assert.match(result.headers.get("Cache-Control")!,/private, no-store/)
  for(const options of [{rpcThrow:true},{serviceKey:false},{error:{message:"PRIVATE endpoint credentials",code:"PRIVATE"}}]) {
    const result=await harness(options).request(null,{method:"GET"})
    assert.equal(result.status,503);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE|credentials/)
  }
})

test("creation PUT checks Edit first, rejects forged identity/prices/order, and performs one audited allocation", async () => {
  const requestId="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", body={operation:"create",requestId,kind:"port",actorId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",expectedVersion:"0"}
  const port={...saved,id,name:"New Port",hsfo:null,vlsfo:null,mgo:null,updated_at:null,type:"port",display_order:11}
  const data={requestId,portId:id,kind:"port",replayed:false,port}
  for(const auth of ["Unauthorized","Forbidden"] as const) {
    const app=harness({auth}),result=await app.request(null,{method:"PUT",body:"{bad"})
    assert.equal(result.status,auth==="Unauthorized"?401:403);assert.deepEqual(app.events,["auth"])
  }
  for(const bad of [null,{},[],{...body,requestId:"bad"},{...body,kind:"PORT"},{...body,operation:"save"},{...body,id},{...body,hsfo:999},{...body,name:"Existing"},{...body,display_order:1},{...body,portId:id}]) {
    const app=harness();assert.equal((await app.request(bad,{method:"PUT"})).status,400);assert.deepEqual(app.calls,[])
  }
  const app=harness({data}),result=await app.request({...body,requestId:requestId.toUpperCase()},{method:"PUT"})
  assert.equal(result.status,200);assert.deepEqual(app.events,["auth","audit","client","rpc"])
  assert.deepEqual(app.calls,[{name:"create_owned_price_setter_port",args:{p_actor_id:body.actorId,p_request_id:requestId,p_kind:"port",p_expected_version:"0"}}])
  assert.match(result.headers.get("Cache-Control")!,/private, no-store/)
  for(const bad of [null,{}, {...data,extra:true},{...data,requestId:id},{...data,portId:"bad"},{...data,kind:"divider"},{...data,replayed:"yes"},{...data,port:null},
    {...data,port:{...port,id:"bad"}},{...data,port:{...port,hsfo:0}},{...data,port:{...port,type:"divider"}},{...data,port:{...port,name:"Existing"}},
    {...data,port:{...port,display_order:null}},{...data,port:{...port,display_order:1.5}},{...data,port:{...port,updated_at:"2026-10-09"}},
    {...data,port:{id,name:"New Port",type:"port",display_order:1}}]) {
    assert.equal((await harness({data:bad}).request(body,{method:"PUT"})).status,503)
  }
  const replay={...data,replayed:true,port:{...port,name:"Renamed later",hsfo:0,updated_at:"2026-10-09",display_order:null,type:null}}
  assert.equal((await harness({data:replay}).request(body,{method:"PUT"})).status,200)
  assert.equal((await harness({data:{...data,replayed:true,port:null}}).request(body,{method:"PUT"})).status,200)
  for(const [error,status,code] of [[{code:"P0002",message:"CREATION_KIND_CHANGED"},409,"CREATION_KIND_CHANGED"],[{code:"P0002",message:"CREATION_ORDER_FULL"},409,"CREATION_ORDER_FULL"],[{code:"22023",message:"PRIVATE"},400,undefined],[{code:"P0002",message:"PRIVATE"},503,undefined]] as const) {
    const result=await harness({error}).request(body,{method:"PUT"});assert.equal(result.status,status);assert.equal(result.body.code,code);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE/)
  }
  for(const options of [{rpcThrow:true},{serviceKey:false}]) assert.equal((await harness(options).request(body,{method:"PUT"})).status,503)
})

test("deletion checks Edit before privileged work, validates strict baselines and confirms one audited RPC", async () => {
  const body={portId:id,expected:mutation.priceSetterDeletionSnapshot(saved),expectedFallbacks:{}}
  for(const auth of ["Unauthorized","Forbidden"] as const) {
    const app=harness({auth}),result=await app.request(null,{method:"DELETE",body:"{bad"})
    assert.equal(result.status,auth==="Unauthorized"?401:403);assert.deepEqual(app.events,["auth"])
  }
  for(const bad of [null,{}, {...body,extra:true},{...body,portId:"bad"},{...body,expected:{...body.expected,extra:1}},{...body,expected:{...body.expected,type:"bad"}},{...body,expectedFallbacks:{"other::mgo":"SE"}},{...body,expectedFallbacks:{"synthetic port::hsfo":true}}]) {
    const app=harness();assert.equal((await app.request(bad,{method:"DELETE"})).status,400);assert.deepEqual(app.calls,[])
  }
  const app=harness({data:{deletedId:id,replayed:false}}),result=await app.request(body,{method:"DELETE"})
  assert.equal(result.status,200);assert.deepEqual(app.events,["auth","audit","client","rpc"])
  assert.deepEqual(app.calls,[{name:"delete_price_setter_port",args:{p_port_id:id,p_expected:body.expected,p_expected_fallbacks:{}}}])
  assert.match(result.headers.get("Cache-Control")!,/private, no-store/)
  for(const data of [null,{}, {deletedId:id},{deletedId:"other",replayed:true},{deletedId:id,replayed:false,extra:1}]) {
    const result=await harness({data}).request(body,{method:"DELETE"});assert.equal(result.status,503);assert.match(result.body.message,/Could not confirm deletion/)
  }
  for(const [error,status] of [[{code:"P0002",message:"PRIVATE"},409],[{code:"23503",message:"PORT_HISTORY"},409],[{code:"23503",message:"PRIVATE"},409],[{code:"22023",message:"PRIVATE"},400],[{code:"P0001",message:"PRIVATE"},503]] as const) {
    const result=await harness({error}).request(body,{method:"DELETE"});assert.equal(result.status,status);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE/)
  }
})

test("owned creation fails closed on missing server identity or an account change before privileged allocation",async()=>{
  const body={operation:"create",requestId:id,kind:"port",actorId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",expectedVersion:"0"}
  for(const actorId of [null,"cached-admin",""]){const app=harness({actorId});assert.equal((await app.request(body,{method:"PUT"})).status,401);assert.deepEqual(app.events,["auth"])}
  const app=harness({actorId:id}),result=await app.request(body,{method:"PUT"})
  assert.equal(result.status,409);assert.equal(result.body.code,"CREATION_ACCOUNT_CHANGED");assert.deepEqual(app.calls,[])
  assert.deepEqual(app.events,["auth"])
})

test("price API checks Edit authorization before parsing or constructing a privileged client", async () => {
  for (const [auth, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const app = harness({ auth })
    const result = await app.request(null, { body: "not JSON" })
    assert.equal(result.status, status); assert.deepEqual(app.events, ["auth"]); assert.deepEqual(app.calls, [])
    assert.match(result.headers.get("Cache-Control")!, /private, no-store/)
  }
})

test("required report-port rename is a safe conflict, not a technical/uncertain failure", async () => {
  const app = harness({ error: { code: "23503", message: "PORT_REQUIRED_NAME" } })
  const result = await app.request()
  assert.equal(result.status, 409); assert.equal(result.body.code, "PORT_REQUIRED")
  assert.match(result.body.message, /Keep its existing name/)
  assert.match(result.body.message, /draft is still here/)
  assert.doesNotMatch(result.body.message, /23503|PORT_REQUIRED_NAME|SQL|trigger/)
  const unknown = await harness({ error: { code: "23503", message: "PRIVATE unrelated constraint" } }).request()
  assert.equal(unknown.status, 503); assert.doesNotMatch(unknown.body.message, /PRIVATE/)
})

test("settings PATCH requires Edit permission before reading input or creating a privileged client", async () => {
  for (const [auth, status] of [["Unauthorized", 401], ["Forbidden", 403]] as const) {
    const app = harness({ auth }), result = await app.request(null, { method: "PATCH", body: "{bad" })
    assert.equal(result.status, status); assert.deepEqual(app.events, ["auth"]); assert.deepEqual(app.calls, [])
    assert.match(result.headers.get("Cache-Control")!, /no-store/)
  }
})

test("reorder PATCH validates a complete bounded permutation and confirms one audited transaction", async () => {
  const ids = Array.from({ length: 2501 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`)
  const input = { operation: "reorder", expected: ids.map(id => [id, null]), order: [...ids].reverse() }
  assert.ok(JSON.stringify(input).length > 8192)
  const app = harness({ data: { order: input.order.map((id, i) => [id, i + 1]), replayed: false } })
  assert.equal((await app.request(input, { method: "PATCH" })).status, 200)
  assert.deepEqual(app.events, ["auth", "audit", "client", "rpc"])
  assert.deepEqual(app.calls, [{ name: "reorder_price_setter_ports", args: { p_expected: input.expected, p_order: input.order } }])
  for (const bad of [{ ...input, order: ids.slice(1) }, { ...input, extra: true }, { ...input, expected: [[ids[0], null], [ids[0], null]], order: ids.slice(0, 2) }]) {
    const rejected = harness(); assert.equal((await rejected.request(bad, { method: "PATCH" })).status, 400); assert.deepEqual(rejected.calls, [])
  }
  for (const data of [null, {}, { order: input.expected, replayed: false }, { order: input.order.map((id, i) => [id, i + 1]) }]) {
    assert.equal((await harness({ data }).request(input, { method: "PATCH" })).status, 503)
  }
  for (const auth of ["Unauthorized", "Forbidden"] as const) {
    const denied = harness({ auth }); assert.equal((await denied.request(input, { method: "PATCH" })).status, auth === "Unauthorized" ? 401 : 403); assert.deepEqual(denied.calls, [])
  }
  const oversized = harness(); assert.equal((await oversized.request(input, { method: "PATCH", body: " ".repeat(4000001) })).status, 400); assert.deepEqual(oversized.calls, [])
})

test("settings PATCH uses exactly one narrow audited RPC and confirms its returned value", async () => {
  const fallback = { operation: "fallback", key: "synthetic port::hsfo", expectedValue: null, value: "SE" }
  const first = harness({ data: { key: fallback.key, fallbacks: { [fallback.key]: "SE", "other::mgo": "NA" } } })
  assert.equal((await first.request(fallback, { method: "PATCH" })).status, 200)
  assert.deepEqual(first.events, ["auth", "audit", "client", "rpc"])
  assert.deepEqual(first.calls, [{ name: "save_price_setter_fallback", args: { p_key: fallback.key, p_expected_value: null, p_value: "SE" } }])
  const divider = { operation: "divider", portId: id, expectedName: "Old", name: " New " }
  const second = harness({ data: { port: { id, ...saved, name: "New", type: "divider" } } })
  assert.equal((await second.request(divider, { method: "PATCH" })).status, 200)
  assert.deepEqual(second.calls, [{ name: "rename_price_setter_divider", args: { p_port_id: id, p_expected_name: "Old", p_name: "New" } }])
})

test("settings PATCH rejects spoofed fields, malformed input, and unconfirmed saves safely", async () => {
  const fallback = { operation: "fallback", key: "synthetic port::hsfo", expectedValue: null, value: "NA" }
  for (const invalid of [null, {}, [], { ...fallback, id: 101 }, { ...fallback, value: "bad" }, { ...fallback, expectedValue: 1 }, { operation: "divider", portId: id, expectedName: "Old", name: " " }]) {
    const app = harness(); assert.equal((await app.request(invalid, { method: "PATCH" })).status, 400); assert.deepEqual(app.events, ["auth"])
  }
  for (const config of [{ body: "{bad" }, { body: " ".repeat(131073) }, { headers: { "Content-Type": "text/plain" } }]) {
    const app = harness(); assert.equal((await app.request(fallback, { ...config, method: "PATCH" })).status, 400); assert.deepEqual(app.calls, [])
  }
  for (const [error, status] of [[{ code: "P0002", message: "PRIVATE" }, 409], [{ code: "22023", message: "PRIVATE" }, 400], [{ code: "P0001", message: "PRIVATE" }, 503]] as const) {
    const app = harness({ error }), result = await app.request(fallback, { method: "PATCH" })
    assert.equal(result.status, status); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE/)
    if (status === 409) assert.equal(result.body.code, "PRICE_CONFLICT")
  }
  for (const options of [{ rpcThrow: true }, { serviceKey: false }, { data: null }, { data: {} }, { data: { key: fallback.key, fallbacks: { [fallback.key]: "SE" } } }, { data: { key: "wrong", fallbacks: { [fallback.key]: "NA" } } }, { data: { key: fallback.key, fallbacks: { [fallback.key]: "NA", bad: "NA" } } }]) {
    const app = harness(options), result = await app.request(fallback, { method: "PATCH" })
    assert.equal(result.status, 503); assert.match(result.body.message, /draft is still here/); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE/)
  }
  for (const data of [{ port: { id, name: "New", type: "divider" } }, { port: { id, name: "New", type: "port" } }, { port: { id: "wrong", ...saved, name: "New", type: "divider" } }, { port: { id, ...saved, name: "Other", type: "divider" } }, { port: { id, ...saved, name: "New", type: "divider", updated_at: "bad" } }]) {
    assert.equal((await harness({ data }).request({ operation: "divider", portId: id, expectedName: "Old", name: "New" }, { method: "PATCH" })).status, 503)
  }
})

test("price API issues one audited atomic RPC, preserves zero, and owns its timestamp", async () => {
  const app = harness(), before = Date.now()
  const result = await app.request()
  assert.equal(result.status, 200); assert.deepEqual(app.events, ["auth", "audit", "client", "rpc"])
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].name, "save_price_setter_port")
  assert.deepEqual(app.calls[0].args.p_expected, saved); assert.equal((app.calls[0].args.p_changes as { hsfo: number }).hsfo, 0)
  assert.ok(Date.parse(String(app.calls[0].args.p_recorded_at)) >= before)
  assert.ok(Date.parse(String(app.calls[0].args.p_recorded_at)) <= Date.now())
  assert.match(result.headers.get("Cache-Control")!, /no-store/)
})

test("price API refuses malformed, oversized and spoofed input without a database call", async () => {
  for (const body of [null, [], {}, { ...input(), recorded_at: "1999-01-01" }, { ...input(), portId: "not-uuid" }, { ...input(), changes: { ...input().changes, hsfo: "NaN" } }, { ...input(), expected: { ...saved, type: "divider" } }]) {
    const app = harness(); assert.equal((await app.request(body)).status, 400); assert.deepEqual(app.events, ["auth"])
  }
  const malformedRequests: RequestInit[] = [{ body: "{bad" }, { headers: { "Content-Type": "text/plain" } }, { body: " ".repeat(8193) }, { headers: { "Content-Type": "application/json", "Content-Length": "9000" } }]
  for (const config of malformedRequests) {
    const app = harness(); assert.equal((await app.request(input(), config)).status, 400); assert.deepEqual(app.events, ["auth"])
  }
})

test("price API handles failed and uncertain saves in plain language without leaking database details", async () => {
  for (const [error, status] of [[{ code: "P0002", message: "PRIVATE row detail" }, 409], [{ code: "22023", message: "PRIVATE row detail" }, 400], [{ code: "40P01", message: "PRIVATE connection detail" }, 503]] as const) {
    const app = harness({ error }), result = await app.request()
    assert.equal(result.status, status); assert.equal(app.calls.length, 1); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE/)
    if (status === 409) { assert.equal(result.body.code, "PRICE_CONFLICT"); assert.match(result.body.message, /draft is still here/) }
  }
  for (const options of [{ rpcThrow: true }, { serviceKey: false }, { data: null }, { data: {} }, { data: { ports: [null] } }, { data: { ports: [{ id: "wrong-port" }] } }, { data: { ports: [{ id, ...saved, hsfo: 0 }] } }]) {
    const app = harness(options), result = await app.request()
    assert.equal(result.status, 503); assert.match(result.body.message, /could not be confirmed/); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE/)
    assert.equal(app.calls.length, options.serviceKey === false ? 0 : 1)
  }
})

test("price API cancels a stalled or aborted body and does not reach the database", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let cancelled = false
  const app = harness(), body = new ReadableStream({ cancel() { cancelled = true } })
  const pending = app.request(input(), { body, duplex: "half" } as RequestInit)
  await Promise.resolve(); await Promise.resolve()
  t.mock.timers.tick(5001)
  assert.equal((await pending).status, 400); assert.equal(cancelled, true); assert.deepEqual(app.calls, [])
  const aborted = harness(), controller = new AbortController()
  controller.abort()
  assert.equal((await aborted.request(input(), { signal: controller.signal })).status, 400)
  assert.deepEqual(aborted.calls, [])
})
