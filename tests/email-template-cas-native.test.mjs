import assert from "node:assert/strict"
import test from "node:test"
import { setupTemplateCas, inputTemplate, saveSql, deleteSql, json, signatures, literal, source, migrationPath } from "./fixtures/email-template-cas-native.mjs"

test("native canonical write conflicts are nonretryable and atomic at all ten deliberate guards", { timeout: 120000 }, async t => {
  const f = await setupTemplateCas()
  try {
    const cases = [
      ["save revision mismatch", saveSql(inputTemplate(), "2")],
      ["save timestamp mismatch", saveSql(inputTemplate(), "null", "'2000-01-01'::timestamptz")],
      ["save missing baseline", saveSql(inputTemplate())],
      ["save vanished row", saveSql(inputTemplate({ id: "vanished", slug: "vanished" }), "1")],
      ["delete revision mismatch", deleteSql("target", "2")],
      ["delete timestamp mismatch", deleteSql("target", "null", "'2000-01-01'::timestamptz")],
      ["delete missing baseline", deleteSql()],
      ["library missing revision", `select public.replace_email_template_library_canonical('[]',null);`],
      ["library stale revision", `select public.replace_email_template_library_canonical('[]','${"0".repeat(64)}');`],
      ["repair stale revision", `select public.repair_email_templates_canonical(${json([{ ...inputTemplate(), expected_revision: 2 }])});`],
    ]
    for (const [name, sql] of cases) await t.test(name, async () => {
      const before = await f.snapshot()
      await assert.rejects(f.execute(sql), error => {
        assert.equal(error.code, "P0001")
        assert.match(error.message, /ERROR:\s+P0001: EMAIL_TEMPLATE_CONFLICT(?:\n|$)/)
        return true
      })
      assert.deepEqual(await f.snapshot(), before, "failed CAS cannot mutate rows, audit, or backup fence")
    })
    await t.test("repair missing target is also a conflict", async () => {
      const before = await f.snapshot()
      await assert.rejects(f.execute(`select public.repair_email_templates_canonical(${json([{ ...inputTemplate({ id: "vanished", slug: "vanished" }), expected_revision: 1 }])});`), error => error.code === "P0001")
      assert.deepEqual(await f.snapshot(), before)
    })
  } finally { await f.close() }
})

test("native replacement preserves exact function identities, body semantics, invoker settings and ACL", { timeout: 120000 }, async () => {
  const f = await setupTemplateCas()
  try {
    assert.deepEqual(await f.identities(), f.beforeIdentities)
    const after = await f.owner.one(`select jsonb_object_agg(proname,prosrc) from pg_proc where oid=any(array[${signatures.map(s => `${literal(s)}::regprocedure::oid`).join(",")}]);`)
    let changed = 0
    for (const [name, body] of Object.entries(f.beforeBodies)) {
      changed += [...body.matchAll(/errcode = '40001'/g)].length
      assert.equal(after[name], body.replaceAll("errcode = '40001'", "errcode = 'P0001'"), name)
    }
    assert.equal(changed, 10)
    for (const identity of await f.identities()) {
      assert.equal(identity.invoker, true)
      assert.equal(identity.anon, false)
      assert.equal(identity.authenticated, false)
      assert.equal(identity.service, true)
    }
    for (const role of ["anon", "authenticated"]) {
      const session = await f.session(`denied-${role}`, false)
      try {
        await assert.rejects(session.query(`set role ${role}; ${deleteSql("absent", "1")}`), error => error.code === "42501")
      } finally { await session.close() }
    }
  } finally { await f.close() }
})

test("native current save, timestamp fallback, create, library swap, repair and deletion retain success behavior", { timeout: 120000 }, async () => {
  const f = await setupTemplateCas()
  try {
    const first = await f.execute(saveSql(inputTemplate({ title: "Changed" }), "1"))
    assert.equal(first.revision, 2)
    const second = await f.execute(saveSql(inputTemplate({ title: "Timestamp fallback" }), "null", `${literal(first.updated_at)}::timestamptz`))
    assert.equal(second.revision, 3)
    const created = await f.execute(saveSql(inputTemplate({ id: "created", slug: "created" }), "0"))
    assert.equal(created.revision, 1)
    const beforeRepair = await f.snapshot()
    const repaired = await f.execute(`select public.repair_email_templates_canonical(${json([{ ...inputTemplate({ title: "Repaired" }), expected_revision: 3 }])});`)
    assert.equal(repaired[0].revision, 4)
    assert.equal((await f.snapshot()).audit.length, beforeRepair.audit.length + 1)
    const revision = await f.libraryRevision()
    const replaced = await f.execute(`select public.replace_email_template_library_canonical(${json([inputTemplate({ title: "Library target", slug: "remaining" }), inputTemplate({ id: "remaining", title: "Library remaining", slug: "target" })])},${literal(revision)});`)
    assert.equal(replaced.templates.length, 2)
    assert.equal(replaced.templates.find(row => row.id === "target").slug, "remaining")
    const absentBefore = await f.snapshot()
    assert.equal(await f.execute(deleteSql("absent", "1")), null)
    assert.deepEqual(await f.snapshot(), absentBefore)
    const deleted = await f.execute(deleteSql("target", String(replaced.templates.find(row => row.id === "target").revision)))
    assert.equal(deleted.id, "target")
    const after = await f.snapshot()
    assert.deepEqual(after.templates.map(row => row.id), ["remaining"])
    assert.equal(after.audit.filter(row => row.operation === "DELETE" && row.before_row.id === "target").length, 1)
    const beforeLast = await f.snapshot()
    await assert.rejects(f.execute(deleteSql("remaining", String(after.templates[0].revision))), error => error.code === "23514" && /EMAIL_TEMPLATE_LIBRARY_EMPTY_FORBIDDEN/.test(error.message))
    assert.deepEqual(await f.snapshot(), beforeLast)
  } finally { await f.close() }
})

test("native migration source fence refuses drift before replacing any canonical function", { timeout: 120000 }, async () => {
  const f = await setupTemplateCas({ repaired: false })
  try {
    const definition = await f.owner.one("select to_jsonb(pg_get_functiondef('public.delete_email_template_canonical(text,bigint,timestamptz)'::regprocedure));")
    assert.ok(definition.includes("AS $function$\n"))
    await f.owner.query(`${definition.replace("AS $function$\n", () => "AS $function$\n-- synthetic independently changed definition\n")};`)
    const before = await f.identities()
    const bodies = await f.owner.one(`select jsonb_object_agg(proname,prosrc) from pg_proc where oid=any(array[${signatures.map(s => `${literal(s)}::regprocedure::oid`).join(",")}]);`)
    const migration = await f.session("migration-owner", false)
    try {
      await assert.rejects(migration.query(`begin; ${source(migrationPath)} commit;`), error => error.code === "55000" && /EMAIL_TEMPLATE_CANONICAL_SOURCE_MISMATCH/.test(error.message))
    } finally { await migration.close() }
    assert.deepEqual(await f.identities(), before)
    assert.deepEqual(await f.owner.one(`select jsonb_object_agg(proname,prosrc) from pg_proc where oid=any(array[${signatures.map(s => `${literal(s)}::regprocedure::oid`).join(",")}]);`), bodies)
  } finally { await f.close() }
})
