import assert from "node:assert/strict"
import test from "node:test"
import { confirmPriceSetterInventory } from "../lib/priceSetterInventory"

const port = (n=1, extra={}) => ({id:`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,name:`Port ${n}`,type:"port",display_order:n,
  lat:null,lng:null,hsfo:0,vlsfo:null,mgo:999.5,hsfo_formula:null,vlsfo_formula:null,mgo_formula:null,updated_at:"2026-10-09",...extra})
const inventory = (ports: unknown[]) => ({version:1,count:ports.length,ports})
test("complete inventory supports empty and >1000 rows without a smaller arbitrary cap", () => {
  assert.deepEqual(confirmPriceSetterInventory(inventory([])),inventory([]))
  const value=inventory(Array.from({length:2501},(_,i)=>port(i+1)))
  assert.deepEqual(confirmPriceSetterInventory(value),value)
  const legacy=inventory([port(1,{type:null,display_order:-2,hsfo_formula:"Invalid legacy formula to repair"}),port(2,{type:"divider",display_order:null,updated_at:null})])
  assert.deepEqual(confirmPriceSetterInventory(legacy),legacy)
})
test("inventory rejects truncation, malformed or missing fields, unsafe numbers, duplicate identity and unstable order", () => {
  const valid=inventory([port()])
  for(const value of [null,[],{}, {...valid,version:2},{...valid,count:2},{...valid,count:-1},{...valid,count:"1"},{...valid,count:1.5},{...valid,extra:true},
    inventory([null]),inventory([{}]),inventory([port(),port()]),inventory([port(2),port(1)]),inventory([port(1,{display_order:null}),port(2)]),
    ...[{id:"1"},{type:"unknown"},{display_order:2147483648},{display_order:1.5},{display_order:"1"},{hsfo:-1},{hsfo:"0"},{lat:91},{lng:-181},
      {mgo:Infinity},{updated_at:"2026-02-30"},{updated_at:undefined},{hsfo_formula:0},{extra:1},{name:""}].map(extra=>inventory([port(1,extra)])),
    Object.assign(Object.create({version:1,count:0}),{ports:[],extra:1,other:2})]) {
    assert.throws(()=>confirmPriceSetterInventory(value),/complete saved port list/)
  }
  for(const key of Object.keys(port())) {
    const row:Record<string,unknown>=port();delete row[key]
    assert.throws(()=>confirmPriceSetterInventory(inventory([row])),/complete saved port list/,key)
  }
  assert.throws(()=>confirmPriceSetterInventory(inventory([port(2,{display_order:1}),port(1,{display_order:1})])))
})
