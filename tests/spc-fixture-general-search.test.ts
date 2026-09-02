import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { matchesSpcFixtureSearch } from "../lib/spcFixtureSearch"

const fixturesPage = readFileSync(new URL("../app/spc/fixtures/page.tsx", import.meta.url), "utf8")
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")

test("fixture search matches requested fields without case or punctuation sensitivity", () => {
  const values = ["LANA-SG", "OTTO LAI-HK", "CHINA STEEL BRILLIANCE", "BP MARINE"]

  assert.equal(matchesSpcFixtureSearch("lana", values), true)
  assert.equal(matchesSpcFixtureSearch("otto hk", values), true)
  assert.equal(matchesSpcFixtureSearch("china-steel", values), true)
  assert.equal(matchesSpcFixtureSearch("bp marine", values), true)
  assert.equal(matchesSpcFixtureSearch("lana china bp", values), true)
  assert.equal(matchesSpcFixtureSearch("michelle", values), false)
  assert.equal(matchesSpcFixtureSearch("", values), true)
})

test("fixture search does not treat grade labels as supplier names", () => {
  const supplierValues = ["BP MARINE", "TFG MARINE"]

  assert.equal(matchesSpcFixtureSearch("bp", supplierValues), true)
  assert.equal(matchesSpcFixtureSearch("tfg", supplierValues), true)
  assert.equal(matchesSpcFixtureSearch("hsfo", supplierValues), false)
})

test("fixtures page shows one simple toolbar search and applies it to both sections", () => {
  assert.match(fixturesPage, /className="spc-fixture-ledger-toolbar"[\s\S]*?type="search"[\s\S]*?className="spc-fixture-search-input"/)
  assert.match(fixturesPage, /aria-label="Search fixtures"/)
  assert.match(fixturesPage, /placeholder="SEARCH"/)
  assert.match(fixturesPage, /const filteredPendingFixtures = useMemo/)
  assert.match(fixturesPage, /completedFixtures\.filter\(\(fixture\) =>[\s\S]*?fixtureMatchesSearch\(fixture\)/)
  assert.match(fixturesPage, /renderFixtureRows\(filteredPendingFixtures, "pending"\)/)
  assert.match(fixturesPage, /renderFixtureRows\(filteredCompletedFixtures, "completed"\)/)
  assert.match(styles, /\.spc-fixture-search-input\s*\{[^}]*width:\s*min\(320px, calc\(100% - 100px\)\)/)
})

test("fixture search is limited to traders, vessel, and supplier values", () => {
  const searchBlock = fixturesPage.match(/return matchesSpcFixtureSearch\(fixtureSearchQuery, \[([\s\S]*?)\n\s*\]\)/)?.[1] || ""

  assert.match(searchBlock, /supplierTrader/)
  assert.match(searchBlock, /buyerTrader/)
  assert.match(searchBlock, /vesselName/)
  assert.match(searchBlock, /supplierSearchValues\(fixture\.supplierName\)/)
  assert.match(searchBlock, /supplierSearchValues\(draft\.supplierName\)/)
  assert.doesNotMatch(searchBlock, /fixtureDate|earliestEta|account|price|barging/)
})
