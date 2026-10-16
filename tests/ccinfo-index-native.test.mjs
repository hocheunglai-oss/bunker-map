import assert from "node:assert/strict"
import test from "node:test"
import { buildCcinfoIndexSearchFilter } from "../lib/ccinfoIndex.ts"
import { fixtureSql } from "./fixtures/ccinfo-country-rename-sql.mjs"
import { setupNativeCcinfo, literal } from "./fixtures/native-postgres-ccinfo.mjs"

test("native PostgreSQL 17.6: quoted IMATCH literal director preserves punctuation, case and substring semantics", { timeout: 90000 }, async t => {
  const f = await setupNativeCcinfo(fixtureSql())
  t.diagnostic(`Owned native cluster ${f.root}; runtime ${f.version}; SHA-256 ${f.runtimeSha256}`)
  try {
    for (const needle of ["ACME, INC.", "ACME_1", "100% FUEL", 'ACME "HK"', "ACME (HK)", "ACME *HK", "ACME\\HK", "[a-z]+", "(?i).*", "***=X", "CÔTE D'IVOIRE", "港口", "a:b"]) {
      const filter = buildCcinfoIndexSearchFilter("company", needle)
      // The actual builder's quoted string is JSON-compatible because it only
      // escapes quotes/backslashes and rejects control/invalid Unicode input.
      // This is its value after PostgREST pQuotedValue, not a new search pattern.
      const quoted = filter.slice("name.imatch.".length, filter.indexOf(",notes.imatch."))
      const pattern = JSON.parse(quoted)
      assert.equal(pattern, `***=${needle}`)
      const escapedLike = needle.replace(/[\\%_]/g, value => `\\${value}`)
      const answer = await f.owner.one(`select jsonb_build_object('contains',${literal(`PREFIX ${needle} SUFFIX`)}::text ~* ${literal(pattern)},'caseInsensitive',${literal(`PREFIX ${needle.toLowerCase()} SUFFIX`)}::text ~* ${literal(pattern)},'originalLocaleCase',${literal(`PREFIX ${needle.toLowerCase()} SUFFIX`)}::text ilike ${literal(`%${escapedLike}%`)},'unrelated','ENTIRELY UNRELATED'::text ~* ${literal(pattern)});`)
      assert.equal(answer.contains, true, needle)
      assert.equal(answer.unrelated, false, needle)
      assert.equal(answer.caseInsensitive, answer.originalLocaleCase, `${needle}: retain the active PostgreSQL locale's ILIKE case behavior`)
      if (!/[^\x00-\x7f]/.test(needle)) assert.equal(answer.caseInsensitive, true, needle)
    }
    const wildcard = await f.owner.one(`select jsonb_build_object('oldUnderscore','ACB' ilike '%A_B%','newUnderscore','ACB' ~* '***=A_B','oldPercent','ACB' ilike '%A%B%','newPercent','ACB' ~* '***=A%B','postgrestStarAlias','ACB' ilike '%A%B%','newStar','ACB' ~* '***=A*B','literalStar','A*B' ~* '***=A*B','optionsNotExecutable','ANYTHING' ~* '***=(?i).*');`)
    assert.deepEqual(wildcard, { oldUnderscore: true, newUnderscore: false, oldPercent: true, newPercent: false, postgrestStarAlias: true, newStar: false, literalStar: true, optionsNotExecutable: false })
    const immutable = await f.owner.one("select jsonb_build_object('countries',(select count(*) from public.cc_countries),'ports',(select count(*) from public.cc_ports),'audit',(select count(*) from public.audit_logs));")
    assert.deepEqual(immutable, { countries: 3, ports: 4, audit: 0 })
  } finally {
    await f.close()
    t.diagnostic("All owned sessions closed and native server stopped; no hosted SQL.")
  }
})
