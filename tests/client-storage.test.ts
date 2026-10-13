import assert from "node:assert/strict"
import { test } from "node:test"
import { readClientStorage, removeClientStorage, writeClientStorage } from "../lib/clientStorage"

function withWindow(value: object | undefined, check: () => void) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window")
  if (value) Object.defineProperty(globalThis, "window", { configurable: true, value })
  else Reflect.deleteProperty(globalThis, "window")
  try { check() } finally {
    if (prior) Object.defineProperty(globalThis, "window", prior)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

test("normal storage preserves existing keys and cross-document updates", () => {
  const values = new Map<string, string>()
  withWindow({ localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } }, () => {
    writeClientStorage("normal", "first")
    assert.equal(readClientStorage("normal"), "first")
    values.set("normal", "changed-elsewhere")
    assert.equal(readClientStorage("normal"), "changed-elsewhere")
    removeClientStorage("normal")
    assert.equal(readClientStorage("normal"), null)
  })
})

test("blocked localStorage getter cannot break metadata publication or clearing", () => {
  withWindow({ get localStorage() { throw new Error("storage disabled") } }, () => {
    assert.equal(readClientStorage("blocked"), null)
    writeClientStorage("blocked", "latest")
    assert.equal(readClientStorage("blocked"), "latest")
    removeClientStorage("blocked")
    assert.equal(readClientStorage("blocked"), null)
  })
})

test("quota failure keeps fresh metadata and failed removal masks stale persisted actor", () => {
  const values = new Map([["quota", "old"]])
  let blocked = true
  withWindow({ localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (blocked) throw new Error("quota"); values.set(key, value) }, removeItem: (key: string) => { if (blocked) throw new Error("blocked"); values.delete(key) } } }, () => {
    writeClientStorage("quota", "new")
    assert.equal(readClientStorage("quota"), "new")
    assert.equal(values.get("quota"), "old")
    removeClientStorage("quota")
    assert.equal(readClientStorage("quota"), null)
    blocked = false
    writeClientStorage("quota", "recovered")
    assert.equal(values.get("quota"), "recovered")
    values.set("quota", "cross-document")
    assert.equal(readClientStorage("quota"), "cross-document", "successful persistence releases the fallback")
  })
})

test("server calls neither persist nor reveal browser fallback state", () => {
  withWindow({ get localStorage() { throw new Error("blocked") } }, () => writeClientStorage("browser-only", "actor"))
  withWindow(undefined, () => {
    assert.equal(readClientStorage("browser-only"), null)
    writeClientStorage("server-only", "must-not-persist")
    removeClientStorage("browser-only")
  })
  withWindow({ localStorage: { getItem: () => null } }, () => {
    assert.equal(readClientStorage("browser-only"), "actor", "server removal must not mutate any browser cache")
    assert.equal(readClientStorage("server-only"), null)
    removeClientStorage("browser-only")
  })
})
