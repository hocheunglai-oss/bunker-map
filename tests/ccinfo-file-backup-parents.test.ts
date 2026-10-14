import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

type Row = Record<string, unknown>
type Data = Record<string, Row[]>
const rows = (data: Data, key: string) => data[key] || []
const idSet = (data: Data, key: string) => new Set(rows(data, key).map((row) => row.id))
const source = readFileSync(new URL("../scripts/validate-backup.mjs", import.meta.url), "utf8")
const from = source.indexOf("  const polymorphicParents = {")
const to = source.indexOf('  for (const key of ["ccCompanyFiles", "ccEntryFiles"])', from)
assert.ok(from >= 0 && to > from, "The actual offline validator parent checks must be present")
const check = new Function("data", "rows", "idSet", "isPlainObject", "isPresentPrimaryKeyValue", "addError", `
  const companyIds = idSet(data, "ccCompanies"), countryIds = idSet(data, "ccCountries"), errors = [];
  ${source.slice(from, to)}
  return errors;
`) as (data: Data, ...dependencies: unknown[]) => string[]
const validate = (data: Data) => check(data, rows, idSet,
  (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value),
  (value: unknown) => value !== null && value !== undefined && value !== "",
  (errors: string[], message: string) => errors.push(message))

test("offline backup validation accepts CCINFO port files and folders, including deleted references", () => {
  const data: Data = {
    ccCompanies: [{ id: "company" }], ccCountries: [{ id: "country" }], ccPorts: [{ id: "cc-port" }],
    ports: [{ id: "pricing-port" }],
    ccEntryFiles: [
      { entry_kind: "company", entry_id: "company" }, { entry_kind: "country", entry_id: "country" },
      { entry_kind: "port", entry_id: "cc-port" }, { entry_kind: "port", entry_id: "cc-port", deleted_at: "2026-10-14T00:00:00Z" },
    ],
    ccEntryFolders: [{ entry_kind: "port", entry_id: "cc-port", implicit: false }, { entry_kind: "port", entry_id: "cc-port", implicit: true }],
  }
  assert.deepEqual(validate(data), [])
})

test("a pricing port is not a CCINFO parent; missing and unsupported references still fail closed", () => {
  for (const key of ["ccEntryFiles", "ccEntryFolders"]) {
    const base = { ccPorts: [{ id: "cc-port" }], ports: [{ id: "pricing-port" }] }
    assert.match(validate({ ...base, [key]: [{ entry_kind: "port", entry_id: "pricing-port" }] }).join(" "), /missing parent reference/)
    assert.match(validate({ ...base, [key]: [{ entry_kind: "port", entry_id: "missing" }] }).join(" "), /missing parent reference/)
    assert.match(validate({ ...base, [key]: [{ entry_kind: "port", entry_id: null }] }).join(" "), /required value/)
    assert.match(validate({ ...base, [key]: [{ entry_kind: "unknown", entry_id: "cc-port" }] }).join(" "), /unsupported value/)
    assert.match(validate({ ...base, ccPorts: [], [key]: [{ entry_kind: "port", entry_id: "cc-port" }] }).join(" "), /missing parent reference/)
  }
})
