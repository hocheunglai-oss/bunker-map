import assert from "node:assert/strict"
import test from "node:test"
import { statisticsRuntime, statisticsData, statisticsWire } from "./fixtures/spc-statistics-api.mjs"

test("actual statistics route aggregates all 5001 eligible rows using one source RPC", async () => {
  let calls=0
  const route=statisticsRuntime({client:{async rpc(name:string,args:Record<string,unknown>){assert.equal(name,"read_spc_statistics_source");calls++;return {data:statisticsWire(statisticsData(5001),args),error:null}}}})
  const result=await route.get()
  assert.equal(result.status,200);assert.equal(calls,1)
  assert.deepEqual(result.body.sourceCounts,{graphFixtures:5001,importedFixtures:0,nativeFixtures:5001,nativeEnquiries:5001})
  assert.equal(result.body.workload[0].enquiries,5001);assert.equal(result.body.monthlyVolume[9].currentYearVolume,500100)
  assert.equal(result.body.volumeBySupplier[0].value,500100);assert.equal(result.body.fixturesBySupplier[0].value,5001)
  assert.equal(result.headers["cache-control"],"private, no-store")
})
test("fresh hit and in-flight dedupe preserve one verified load; every request authorizes", async () => {
  let calls=0,release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve})
  const route=statisticsRuntime({client:{async rpc(_name:string,args:Record<string,unknown>){calls++;await held;return {data:statisticsWire(statisticsData(),args),error:null}}}})
  const first=route.get(),second=route.get();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release()
  assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal((await route.get()).status,200);assert.equal(calls,1);assert.equal(route.authChecks.length,3)
  route.state.permission="signed-out";assert.equal((await route.get()).status,401);assert.equal(calls,1)
  route.state.permission="none";assert.equal((await route.get()).status,403);assert.equal(calls,1)
})
test("expired cache and explicit refresh failures never return silent stale 200", async () => {
  let fail=false,calls=0
  const route=statisticsRuntime({client:{async rpc(_name:string,args:Record<string,unknown>){calls++;return fail?{data:null,error:new Error("Synthetic complete-read failure")}: {data:statisticsWire(statisticsData(),args),error:null}}}})
  assert.equal((await route.get()).status,200);fail=true;route.state.now+=61000
  for(const refresh of [false,true]){const result=await route.get({refresh});assert.equal(result.status,500);assert.match(result.body.message,/complete-read failure/);assert.equal(result.headers["cache-control"],"private, no-store");assert.equal(result.body.monthlyVolume,undefined)}
  fail=false;assert.equal((await route.get({refresh:true})).status,200);assert.equal(calls,4)
})
test("incomplete/malformed/misbound/duplicated/oversize source responses fail closed", async () => {
  const faults=[(wire:any)=>{wire.complete=false},(wire:any)=>{wire.counts.fixtures=99},(wire:any)=>{wire.bounds.firstFixtureYear=2000},(wire:any)=>{wire.fixtures[0].hsfo=100},(wire:any)=>{wire.fixtures.push(structuredClone(wire.fixtures[0]));wire.counts.fixtures++},(wire:any)=>{wire.users[0].password_hash="must-not-be-exposed"},(wire:any)=>{wire.enquiries[0].created_at="infinity"},(wire:any)=>{wire.roles=[null];wire.counts.roles=1},(wire:any)=>{wire.enquiries[0].title="x".repeat(32*1024*1024)}]
  for(const fault of faults){const route=statisticsRuntime({client:{async rpc(_name:string,args:Record<string,unknown>){const wire=statisticsWire(statisticsData(),args);fault(wire);return {data:wire,error:null}}}});const result=await route.get();assert.equal(result.status,500);assert.match(result.body.message,/incomplete or invalid/)}
})
