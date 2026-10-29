import test from "node:test"
import assert from "node:assert/strict"
import { equivalentRecoverySchemas, equivalentRecoveryDatabase, equivalentRecoveryAclSection, summarizeRecoveryAclTextDifference, buildMissingSchemaAclReplay } from "../lib/postgresRecoveryAcl.mjs"

const items = ["owner=CTc/owner", "delegate=c*/owner", "reader=c/delegate", "=Tc/owner"]
const database = acl => ({ name: "postgres", owner: "owner", encoding: "UTF8", comment: null, acl })
const schema = acl => ({ name: "public", owner: "pg_database_owner", comment: "public schema", acl })
const text = entries => `{${entries.map(value => /[\s{},"\\]/u.test(value) || value === "NULL"
  ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value).join(",")}}`

test("failure ACL summary exposes only bounded classifications and exact-entry multiplicities", () => {
  const privateEntry = '"PRIVATE_ROLE,= SQL"=U*/"PRIVATE_GRANTOR"'
  for (const [left, right, result] of [
    [null, null, { kind: "equivalent", missingEntries: 0, extraEntries: 0 }],
    [null, "{}", { kind: "null-to-value", missingEntries: 0, extraEntries: 0 }],
    [text([privateEntry]), null, { kind: "value-to-null", missingEntries: 0, extraEntries: 0 }],
    [text([...items, privateEntry]), text([privateEntry, ...items.toReversed()]), { kind: "equivalent", missingEntries: 0, extraEntries: 0 }],
    [text([privateEntry, privateEntry]), text([privateEntry]), { kind: "changed", missingEntries: 1, extraEntries: 0 }],
    [text([privateEntry]), text([privateEntry, privateEntry]), { kind: "changed", missingEntries: 0, extraEntries: 1 }],
    [text(["a=U/b"]), text(["a=U*/other"]), { kind: "changed", missingEntries: 1, extraEntries: 1 }],
    ["{PRIVATE_SQL", "{}", { kind: "invalid", missingEntries: 0, extraEntries: 0 }],
    ["{}", { PRIVATE_SQL: "PRIVATE_VALUE" }, { kind: "invalid", missingEntries: 0, extraEntries: 0 }],
  ]) {
    const before = JSON.stringify([left, right]), actual = summarizeRecoveryAclTextDifference(left, right)
    assert.deepEqual(actual, result); assert.equal(JSON.stringify([left, right]), before)
    assert.doesNotMatch(JSON.stringify(actual), /PRIVATE|SQL|GRANTOR|=U|other/)
  }
})

test("database default-ACL reordering preserves exact entry multiplicities and leaves signed inputs untouched", () => {
  const expected = database(items), actual = database([items[3], ...items.slice(0, 3)])
  Object.freeze(expected.acl); Object.freeze(expected); Object.freeze(actual.acl); Object.freeze(actual)
  assert.equal(equivalentRecoveryDatabase(expected, actual), true)
  assert.deepEqual(expected.acl, items)
  assert.deepEqual(actual.acl, [items[3], ...items.slice(0, 3)])
})

test("schema default-ACL reordering preserves every decoded item byte including quoted unusual role names", () => {
  const unusual = '"acl,reader ""quoted"" {} / =\\back"=U*/"grant/or,= ""quoted"""'
  const expected = [schema(text([...items, unusual]))], actual = [schema(text([unusual, ...items.toReversed()]))]
  const before = JSON.stringify([expected, actual])
  assert.equal(equivalentRecoverySchemas(expected, actual), true)
  assert.equal(JSON.stringify([expected, actual]), before)
})

for (const [label, changed] of [
  ["missing privilege", [items[0], items[1], items[2]]],
  ["extra privilege", [...items, "extra=c/owner"]],
  ["grantor", [items[0], items[1], "reader=c/owner", items[3]]],
  ["grantee", [items[0], items[1], "other=c/delegate", items[3]]],
  ["grant option", [items[0], "delegate=c/owner", items[2], items[3]]],
  ["privilege bits", [items[0], items[1], "reader=Cc/delegate", items[3]]],
  ["role case", [items[0], items[1], "Reader=c/delegate", items[3]]],
  ["PUBLIC versus named role", [items[0], items[1], items[2], '"PUBLIC"=Tc/owner']],
  ["duplicate item replacing another", [items[0], items[1], items[1], items[3]]],
]) test(`changed ${label} rejects in both ACL locations`, () => {
  assert.equal(equivalentRecoveryDatabase(database(items), database(changed)), false)
  assert.equal(equivalentRecoverySchemas([schema(text(items))], [schema(text(changed))]), false)
  for (const section of ["relations", "functions", "types"])
    assert.equal(equivalentRecoveryAclSection([schema(text(items))], [schema(text(changed))], section), false)
})

test("duplicate items are counted, never collapsed into a set", () => {
  assert.equal(equivalentRecoveryDatabase(database(["a=U/b", "a=U/b", "c=U/b"]), database(["c=U/b", "a=U/b", "a=U/b"])), true)
  assert.equal(equivalentRecoveryDatabase(database(["a=U/b", "a=U/b", "c=U/b"]), database(["c=U/b", "c=U/b", "a=U/b"])), false)
  assert.equal(equivalentRecoverySchemas([schema(text(["a=U/b", "a=U/b", "c=U/b"]))], [schema(text(["c=U/b", "a=U/b", "a=U/b"]))]), true)
  assert.equal(equivalentRecoverySchemas([schema(text(["a=U/b", "a=U/b", "c=U/b"]))], [schema(text(["c=U/b", "c=U/b", "a=U/b"]))]), false)
})

test("quoted NULL text is never confused with SQL NULL or the role named NULL", () => {
  assert.equal(equivalentRecoverySchemas([schema('{"NULL"}')], [schema("{NULL}")]), false)
  assert.equal(equivalentRecoverySchemas([schema('{"NULL"}')], [schema(null)]), false)
  const entry = '"NULL"=U/owner'
  assert.equal(equivalentRecoverySchemas([schema(text([entry, "other=U/owner"]))], [schema(text(["other=U/owner", entry]))]), true)
  assert.equal(equivalentRecoverySchemas([schema(text([entry]))], [schema('{"NULL"}')]), false)
})

test("NULL remains different from empty or non-default entries", () => {
  assert.equal(equivalentRecoveryDatabase(database(null), database(null)), true)
  assert.equal(equivalentRecoverySchemas([schema(null)], [schema(null)]), true)
  assert.equal(equivalentRecoveryDatabase(database(null), database([])), false)
  assert.equal(equivalentRecoveryDatabase(database(null), database(items)), false)
  assert.equal(equivalentRecoverySchemas([schema(null)], [schema("{}")] ), false)
  assert.equal(equivalentRecoverySchemas([schema(null)], [schema(text(items))]), false)
  assert.equal(equivalentRecoveryDatabase(database([]), database([])), true)
  assert.equal(equivalentRecoverySchemas([schema("{}")], [schema("{}")]), true)
})

test("schema exact owner default and NULL are equivalent in both directions without mutating inputs", () => {
  for (const owner of ["owner", "MixedCase", "123name", "select", "NULL", "space owner", "slash/equals=owner", 'double"quote', "back\\slash", "香港owner", "braces{},comma", "single'quote"]) {
    const encoded = /^[A-Za-z0-9_]+$/.test(owner) ? owner : `"${owner.replaceAll('"', '""')}"`
    const implicit = { name: "example", owner, acl: null, comment: null }, explicit = { ...implicit, acl: text([`${encoded}=UC/${encoded}`]) }
    const before = JSON.stringify([implicit, explicit])
    assert.equal(equivalentRecoverySchemas([implicit], [explicit]), true, owner)
    assert.equal(equivalentRecoverySchemas([explicit], [implicit]), true, owner)
    assert.equal(JSON.stringify([implicit, explicit]), before)
  }
})

for (const [kind, rights] of [["r", "arwdDxtm"], ["p", "arwdDxtm"], ["v", "arwdDxtm"], ["m", "arwdDxtm"], ["f", "arwdDxtm"], ["S", "rwU"]])
  test(`relation kind ${kind} accepts ONLY its exact PostgreSQL 17 owner default`, () => {
    const implicit = { schema: "public", name: "example", kind, owner: "owner", acl: null }
    const explicit = { ...implicit, acl: text([`owner=${rights}/owner`]) }
    assert.equal(equivalentRecoveryAclSection([implicit], [explicit], "relations"), true)
    assert.equal(equivalentRecoveryAclSection([explicit], [implicit], "relations"), true)
    for (let index = 0; index < rights.length; index++) {
      const revoked = rights.slice(0, index) + rights.slice(index + 1)
      assert.equal(equivalentRecoveryAclSection([implicit], [{ ...explicit, acl: text([`owner=${revoked}/owner`]) }], "relations"), false)
    }
    for (const acl of [text([`owner=${rights.slice(1)}/owner`]), text([`owner=${rights}*/owner`]), text([`owner=${rights}/other`]),
      text([`other=${rights}/owner`]), text([`owner=${rights}/owner`, `owner=${rights}/owner`]),
      text([`owner=${rights}/owner`, "reader=r/owner"]), text([`owner=${kind === "S" ? "arwdDxtm" : "rwU"}/owner`]), "{}"])
      assert.equal(equivalentRecoveryAclSection([implicit], [{ ...explicit, acl }], "relations"), false, acl)
    assert.equal(equivalentRecoveryAclSection([implicit], [{ ...explicit, owner: "other" }], "relations"), false)
  })

test("schema default equivalence preserves every revoked, additional, delegated or grant-option right", () => {
  const implicit = { name: "example", owner: "owner", acl: null }
  for (const entries of [[], ["owner=U/owner"], ["owner=C/owner"], ["owner=UC*/owner"], ["owner=U*C*/owner"],
    ["owner=UC/other"], ["other=UC/owner"], ["=UC/owner"], ["owner=UC/owner", "=U/owner"],
    ["owner=UC/owner", "owner=UC/owner"], ["owner=CU/owner"], ['"owner"=UC/owner']])
    assert.equal(equivalentRecoverySchemas([implicit], [{ ...implicit, acl: text(entries) }]), false, JSON.stringify(entries))
  for (const change of [{ owner: "other" }, { comment: "changed" }, { future: true }])
    assert.equal(equivalentRecoverySchemas([implicit], [{ ...implicit, acl: "{owner=UC/owner}", ...change }]), false)
})

test("unknown relation kinds and invalid owner names cannot infer any default", () => {
  for (const kind of [undefined, null, "", "s", "i", "I", "t", "unknown"])
    assert.equal(equivalentRecoveryAclSection([{ name: "x", owner: "owner", kind, acl: null }], [{ name: "x", owner: "owner", kind, acl: "{owner=arwdDxtm/owner}" }], "relations"), false)
  for (const owner of [undefined, null, 1, "", "nul\0name", "a".repeat(64), "港".repeat(22)]) {
    const row = { name: "example", owner, acl: null }
    assert.equal(equivalentRecoverySchemas([row], [{ ...row, acl: text([`${owner}=UC/${owner}`]) }]), false)
  }
})

test("database, function and type defaults remain outside this narrow normalization", () => {
  assert.equal(equivalentRecoveryDatabase(database(null), database(["=Tc/owner", "owner=CTc/owner"])), false)
  for (const section of ["functions", "types"]) for (const acl of ["{owner=UC/owner}", "{owner=arwdDxtm/owner}", "{=X/owner,owner=X/owner}", "{=U/owner,owner=U/owner}"])
    assert.equal(equivalentRecoveryAclSection([{ owner: "owner", kind: "r", acl: null }], [{ owner: "owner", kind: "r", acl }], section), false)
})

test("schema record order, ownership, comments and every other field stay exact", () => {
  const a = schema(text(items)), b = { ...a, name: "other" }
  assert.equal(equivalentRecoverySchemas([a, b], [b, a]), false)
  for (const change of [{ owner: "different" }, { comment: "different" }, { unknownFutureField: true }]) {
    assert.equal(equivalentRecoverySchemas([a], [{ ...a, ...change }]), false)
    assert.equal(equivalentRecoveryDatabase(database(items), { ...database(items), ...change }), false)
  }
  const withOrder = { ...database(items), unknownFutureField: [1, 2] }
  assert.equal(equivalentRecoveryDatabase(withOrder, { ...withOrder, unknownFutureField: [2, 1] }), false)
  assert.equal(equivalentRecoverySchemas([a], [a, a]), false)
})

for (const invalid of [undefined, 1, [], "", "{", "}", "{,}", "{NULL}", "{{a=U/b}}", '{"a=U/b}', '{"a=U/b"x}',
  "{a=U/b,}", "{a=U/b,,c=U/b}", "{ a=U/b}", "{a=U/b }", '[1:1]={a=U/b}', '{""}', '{"a=U/b\\}', "{a=U/\0b}", `{${"x".repeat(8 * 1024 * 1024)}}`])
  test(`malformed or oversized ACL text rejects (${String(invalid).slice(0, 35)})`, () => {
    assert.equal(equivalentRecoverySchemas([schema(invalid)], [schema(invalid)]), false)
  })

test("wrong JSON ACL types, sparse arrays, invalid records and missing ACL fields reject", () => {
  for (const invalid of [undefined, "{}", {}, [null], [1], [""], ["a=U/\0b"], Array(1)])
    assert.equal(equivalentRecoveryDatabase(database(invalid), database(invalid)), false)
  assert.equal(equivalentRecoveryDatabase({}, {}), false)
  assert.equal(equivalentRecoveryDatabase(null, null), false)
  assert.equal(equivalentRecoverySchemas([{}], [{}]), false)
  assert.equal(equivalentRecoverySchemas(Array(1), Array(1)), false)
  assert.equal(equivalentRecoverySchemas(null, []), false)
})

test("ACL array item count and byte limits fail closed", () => {
  const many = Array(100001).fill("a=U/b")
  assert.equal(equivalentRecoveryDatabase(database(many), database(many)), false)
  assert.equal(equivalentRecoverySchemas([schema(text(many))], [schema(text(many))]), false)
  const large = ["x".repeat(8 * 1024 * 1024)]
  assert.equal(equivalentRecoveryDatabase(database(large), database(large)), false)
})

for (const [section, fields] of [
  ["relations", { schema: "public", name: "example", kind: "r", rls: true, force_rls: false, options: ["a=1", "b=2"] }],
  ["functions", { schema: "public", name: "example", identity: "integer", definition: "synthetic definition" }],
  ["types", { schema: "public", name: "example", kind: "e", enum_values: ["first", "last"], not_null: false }],
]) test(`${section} changes only ACL ordering and preserves every other known/unknown field and row order`, () => {
  const original = { ...fields, owner: "owner", comment: null, acl: text(items), future: [1, 2] }
  const reordered = { ...original, acl: text(items.toReversed()) }
  const before = JSON.stringify([original, reordered])
  assert.equal(equivalentRecoveryAclSection([original], [reordered], section), true)
  for (const change of [{ owner: "other" }, { name: "other" }, { comment: "changed" }, { future: [2, 1] },
    { unknown: true }, ...Object.entries(fields).map(([key, value]) => ({ [key]: typeof value === "boolean" ? !value : `${value}-changed` }))])
    assert.equal(equivalentRecoveryAclSection([original], [{ ...reordered, ...change }], section), false)
  const other = { ...original, name: "second" }
  assert.equal(equivalentRecoveryAclSection([original, other], [other, reordered], section), false)
  assert.equal(equivalentRecoveryAclSection([original], [reordered, other], section), false)
  assert.equal(equivalentRecoveryAclSection([{ ...original, acl: null }], [{ ...original, acl: "{}" }], section), false)
  assert.equal(equivalentRecoveryAclSection([{ ...original, acl: '{"broken}' }], [{ ...original, acl: '{"broken}' }], section), false)
  assert.equal(JSON.stringify([original, reordered]), before)
})

test("ACL section selector refuses every other catalog location", () => {
  for (const section of ["schemas", "database", "columns", "constraints", "indexes", "triggers", "policies", "views", "sequences", "extensionTables", "acl", "__proto__", "", undefined, null])
    assert.equal(equivalentRecoveryAclSection([schema(text(items))], [schema(text(items.toReversed()))], section), false)
})

const replayRoles = ["owner", "delegate", "reader", "public"].map(rolname => ({ rolname }))
const replaySchema = acl => ({ name: "example", owner: "owner", comment: null, acl })
const replay = entries => buildMissingSchemaAclReplay([replaySchema(text(entries))], [replaySchema(null)], replayRoles)

test("missing schema ACL replay is one guarded transaction and preserves grantors, options and PUBLIC", () => {
  const source = [replaySchema(text(["reader=U/delegate", "=U/owner", "delegate=U*C*/owner", "owner=UC/owner", "public=C/owner"]))]
  const target = [replaySchema(null)], before = JSON.stringify([source, target, replayRoles])
  const plan = buildMissingSchemaAclReplay(source, target, replayRoles)
  assert.equal(plan.schemas, 1); assert.equal(plan.grants, 7)
  assert.ok(plan.sql.startsWith("BEGIN;\n")); assert.ok(plan.sql.endsWith("\nCOMMIT;"))
  assert.match(plan.sql, /n\.nspacl IS NULL/); assert.match(plan.sql, /n\.nspacl IS NOT NULL/)
  assert.match(plan.sql, /REVOKE ALL PRIVILEGES ON SCHEMA "example" FROM "owner";/)
  assert.ok(plan.sql.indexOf('TO "delegate" WITH GRANT OPTION;') < plan.sql.indexOf('TO "reader";'))
  assert.match(plan.sql, /SET LOCAL ROLE "delegate";\nGRANT USAGE ON SCHEMA "example" TO "reader";/)
  assert.match(plan.sql, /TO PUBLIC;/); assert.match(plan.sql, /TO "public";/)
  assert.match(plan.sql, /COLLATE pg_catalog\."C"/)
  assert.equal(JSON.stringify([source, target, replayRoles]), before)
})

test("missing explicit empty schema ACL revokes implicit owner rights without creating grants", () => {
  const plan = replay([])
  assert.equal(plan.schemas, 1); assert.equal(plan.grants, 0)
  assert.match(plan.sql, /REVOKE ALL PRIVILEGES/); assert.doesNotMatch(plan.sql, /\nGRANT /)
  assert.match(plan.sql, /ARRAY\[\]::pg_catalog\.text\[\]/)
})

test("equal or exact owner-default schema permissions require no replay", () => {
  assert.equal(buildMissingSchemaAclReplay([replaySchema(null)], [replaySchema(null)], replayRoles), null)
  assert.equal(replay(["owner=UC/owner"]), null)
  assert.equal(buildMissingSchemaAclReplay([replaySchema(text(["reader=U/owner", "owner=UC/owner"]))],
    [replaySchema(text(["owner=UC/owner", "reader=U/owner"]))], replayRoles), null)
})

test("owner grant authority remains implicit even if the source revoked owner effective rights", () => {
  const plan = replay(["reader=UC/owner"])
  assert.equal(plan.grants, 2)
  assert.doesNotMatch(plan.sql, /GRANT (?:USAGE|CREATE) ON SCHEMA "example" TO "owner";/)
})

test("schema replay rejects missing/extra/reordered schemas and every non-ACL change", () => {
  const source = replaySchema(text(["reader=U/owner"]))
  for (const target of [[], [replaySchema(null), replaySchema(null)], [{ ...replaySchema(null), name: "other" }],
    [{ ...replaySchema(null), owner: "reader" }], [{ ...replaySchema(null), comment: "changed" }], [{ ...replaySchema(null), future: true }]])
    assert.throws(() => buildMissingSchemaAclReplay([source], target, replayRoles))
  const second = { ...source, name: "second" }
  assert.throws(() => buildMissingSchemaAclReplay([source, second], [{ ...second, acl: null }, replaySchema(null)], replayRoles))
  assert.throws(() => buildMissingSchemaAclReplay([source, source], [replaySchema(null), replaySchema(null)], replayRoles))
})

test("schema replay refuses to overwrite non-NULL ACLs or infer missing signed permissions", () => {
  for (const actual of ["{}", text(["reader=C/owner"]), text(["reader=U/owner", "delegate=U/owner"])])
    assert.throws(() => buildMissingSchemaAclReplay([replaySchema(text(["reader=U/owner"]))], [replaySchema(actual)], replayRoles))
  assert.throws(() => buildMissingSchemaAclReplay([replaySchema(null)], [replaySchema(text(["reader=U/owner"]))], replayRoles))
})

for (const entries of [["reader=U/missing"], ["missing=U/owner"], ["reader=X/owner"], ["reader=UU/owner"], ["reader=CU/owner"],
  ["reader=U**/owner"], ["reader=/owner"], ["=U*/owner"], ["reader=U/owner", "reader=C/owner"],
  ["reader=U/delegate"], ["reader=U*/delegate", "delegate=U*/reader"], ['"reader"=U/owner'], ["reader=U/owner trailing"],
  ['"reader=U/owner'], ["reader=U/owner;RESET ROLE;"]])
  test(`schema replay rejects malformed, unlisted or unreachable ACL (${JSON.stringify(entries)})`, () => assert.throws(() => replay(entries)))

test("schema replay uses exact ACL quoting and SQL escaping for unusual captured names", () => {
  const names = ["MixedCase", "123name", "select", "NULL", "space owner", "slash/equals=owner", 'double"quote', "back\\slash", "香港owner", "braces{},comma", "single'quote", 'x";DROP SCHEMA public;--']
  for (const owner of names) {
    const encoded = /^[A-Za-z0-9_]+$/.test(owner) ? owner : `"${owner.replaceAll('"', '""')}"`
    const row = { name: owner, owner, comment: null, acl: text([`reader=U*/${encoded}`, `${encoded}=UC/${encoded}`]) }
    const plan = buildMissingSchemaAclReplay([row], [{ ...row, acl: null }], [{ rolname: owner }, { rolname: "reader" }])
    assert.equal(plan.schemas, 1); assert.equal(plan.grants, 3)
    assert.ok(plan.sql.includes(`SET LOCAL ROLE "${owner.replaceAll('"', '""')}";`))
    assert.ok(plan.sql.includes(`n.nspname=E'${owner.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`))
  }
})

test("schema replay bounds names, arrays and aggregate ACL input before any SQL is produced", () => {
  const source = replaySchema(text(["reader=U/owner"]))
  for (const roles of [null, [], [{ rolname: "owner" }, { rolname: "owner" }], [{ rolname: "\0" }], [{ rolname: "a".repeat(64) }]])
    assert.throws(() => buildMissingSchemaAclReplay([source], [replaySchema(null)], roles))
  for (const name of ["", "a".repeat(64), "港".repeat(22), "a\0b"])
    assert.throws(() => buildMissingSchemaAclReplay([{ ...source, name }], [{ ...replaySchema(null), name }], replayRoles))
  assert.throws(() => buildMissingSchemaAclReplay(Array(100001), Array(100001), replayRoles))
  assert.throws(() => replay(Array(100001).fill("reader=U/owner")))
})
