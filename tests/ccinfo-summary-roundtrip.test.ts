import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { emptyBcCalculator, normalizeBcCalculator, type BcCalculatorValues } from "../lib/bcCalculator"

type Section = {
  title: string
  info: string
  line_updates?: Record<string, string>
  blocks?: Array<{ id: string; content: string; updated_at: string }>
  table?: string[][]
  column_widths?: number[]
  table_row_updates?: string[]
  sections?: Section[]
  bc_calculator?: BcCalculatorValues
}
type Summary = {
  sections: Section[]
  mainLineUpdates: Record<string, string>
  mainBlocks: Array<{ id: string; content: string; updated_at: string }>
  mainSections: Section[]
}

// Exercise the page's real parsing/serialization functions, without rendering
// the authenticated page or replacing its normalization logic with test doubles.
const source = readFileSync(new URL("../app/admin/ccinfo/page.tsx", import.meta.url), "utf8")
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = ["newBlockId", "lineTimestampKey", "buildLineTimestampKeys", "textToBlocks", "normalizeBlocks", "hasSectionTableLayout", "parseSummaryMeta", "serializeSummaryMeta"]
const declarations = names.map((name) => {
  const declaration = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration, `The actual ${name} function must be present`)
  return declaration.getText(ast)
})
const compiled = ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const { parseSummaryMeta, serializeSummaryMeta } = new Function("normalizeBcCalculator", `${compiled}; return { parseSummaryMeta, serializeSummaryMeta }`)(normalizeBcCalculator) as {
  parseSummaryMeta: (value: string | null) => Summary
  serializeSummaryMeta: (sections: Section[], updates: Record<string, string>, blocks?: Summary["mainBlocks"], mainSections?: Section[]) => string
}
const timestamp = "2026-10-09T01:00:00.000Z"
const supplierTable: Section = {
  title: "SUPPLIER CHARACTERISTICS",
  info: "",
  blocks: [],
  table: [["Supplier", "HSFO", "Remarks"], ["Supplier A", "Y", "Line one\nLine two"], ["Supplier B", "", ""]],
  column_widths: [45, 15, 40],
  table_row_updates: ["", timestamp, "2026-10-08T01:00:00.000Z"],
}
const roundTrip = (value: Summary) => parseSummaryMeta(serializeSummaryMeta(value.sections, value.mainLineUpdates, value.mainBlocks, value.mainSections))

test("General-tab table contents, widths, and row timestamps survive reload and another summary save", () => {
  const initial = { sections: [], mainLineUpdates: {}, mainBlocks: [], mainSections: [supplierTable] }
  const loaded = roundTrip(initial)
  assert.deepEqual(loaded.mainSections[0].table, supplierTable.table)
  assert.deepEqual(loaded.mainSections[0].column_widths, supplierTable.column_widths)
  assert.deepEqual(loaded.mainSections[0].table_row_updates, supplierTable.table_row_updates)
  const originalTable = structuredClone(loaded.mainSections[0])
  loaded.sections.push({ title: "OTHER TAB", info: "Unrelated note", blocks: [] })
  const savedAgain = roundTrip(loaded)
  assert.deepEqual(savedAgain.mainSections[0], originalTable)
  assert.equal(savedAgain.sections[0].info, "Unrelated note")
  assert.ok(supplierTable.table)
  assert.deepEqual(supplierTable.table[1], ["Supplier A", "Y", "Line one\nLine two"], "parsing must not mutate source data")
})

test("Nested-tab and top-level tab tables preserve the same table metadata through reload", () => {
  const loaded = roundTrip({
    sections: [{ ...supplierTable, title: "TABLE TAB", sections: [{ ...supplierTable, title: "NESTED TABLE" }] }],
    mainLineUpdates: {}, mainBlocks: [], mainSections: [],
  })
  for (const section of [loaded.sections[0], loaded.sections[0].sections![0]]) {
    assert.deepEqual(section.table, supplierTable.table)
    assert.deepEqual(section.column_widths, supplierTable.column_widths)
    assert.deepEqual(section.table_row_updates, supplierTable.table_row_updates)
  }
  assert.deepEqual(roundTrip(loaded), loaded)
})

test("BC calculator inputs survive company summary saves and reloads", () => {
  const calculator = emptyBcCalculator()
  calculator.grades[0] = { quantity: "200", buy: "886", sell: "940" }
  calculator.grades[1] = { quantity: "75", buy: "1200", sell: "1320" }
  const loaded = roundTrip({ sections: [{ title: "BC CALCULATOR", info: "", bc_calculator: calculator }], mainLineUpdates: {}, mainBlocks: [], mainSections: [] })
  assert.deepEqual(loaded.sections[0].bc_calculator, calculator)
  loaded.mainSections.push({ title: "OTHER SECTION", info: "A note" })
  assert.deepEqual(roundTrip(loaded).sections[0].bc_calculator, calculator)
})

test("Legacy array summaries retain nested tables and normalize notes without changing the old format behavior", () => {
  const loaded = parseSummaryMeta(JSON.stringify([{ title: "LEGACY TAB", info: "Legacy note", line_updates: { "0": timestamp }, sections: [supplierTable] }]))
  assert.equal(loaded.sections[0].blocks![0].content, "Legacy note")
  assert.equal(loaded.sections[0].blocks![0].updated_at, timestamp)
  assert.deepEqual(loaded.sections[0].sections![0].table, supplierTable.table)
  assert.deepEqual(loaded.mainSections, [])
  assert.deepEqual(roundTrip(loaded), loaded)
})

test("Plain-text and empty summaries retain their compatibility behavior", () => {
  for (const value of [null, "", "  \n  "]) {
    assert.deepEqual(parseSummaryMeta(value), { sections: [], mainLineUpdates: {}, mainBlocks: [], mainSections: [] })
  }
  const loaded = parseSummaryMeta(" First note \n\n Second note ")
  assert.deepEqual(loaded.sections.map((item) => ({ title: item.title, info: item.info })), [{ title: "", info: "First note" }, { title: "", info: "Second note" }])
  const normalized = roundTrip(loaded)
  assert.deepEqual(normalized.sections.map((item) => ({ title: item.title, info: item.info, blocks: item.blocks })), loaded.sections)
  assert.deepEqual(roundTrip(normalized), normalized)
})

test("Main-section text blocks remain unchanged and absent table metadata remains optional", () => {
  const textSection: Section = { title: "GENERAL NOTES", info: "Existing note", line_updates: { "0": timestamp }, blocks: [{ id: "stable-block", content: "Existing note", updated_at: timestamp }] }
  const loaded = roundTrip({ sections: [], mainLineUpdates: { "0": timestamp }, mainBlocks: [], mainSections: [textSection] })
  assert.deepEqual(loaded.mainSections[0].blocks, textSection.blocks)
  assert.deepEqual(loaded.mainSections[0].line_updates, textSection.line_updates)
  assert.equal(loaded.mainSections[0].table, undefined)
  assert.equal(loaded.mainSections[0].column_widths, undefined)
  assert.equal(loaded.mainSections[0].table_row_updates, undefined)
  assert.deepEqual(roundTrip(loaded), loaded)
})

test("Legacy/imported untitled table-only sections and their untitled parent tabs survive round trips", () => {
  const untitledTable = { ...supplierTable, title: "" }
  const emptyLayout: Section = { title: "", info: "", blocks: [], table: [["", ""], ["", ""]], column_widths: [50, 50] }
  const untitledParent: Section = { title: "", info: "", blocks: [], sections: [untitledTable] }
  const loaded = roundTrip({ sections: [untitledTable, untitledParent], mainLineUpdates: {}, mainBlocks: [], mainSections: [untitledTable, emptyLayout] })
  assert.equal(loaded.sections.length, 2)
  assert.deepEqual(loaded.sections[0].table, supplierTable.table)
  assert.deepEqual(loaded.sections[1].sections![0].table, supplierTable.table)
  assert.equal(loaded.mainSections.length, 2)
  assert.deepEqual(loaded.mainSections[0].table_row_updates, supplierTable.table_row_updates)
  assert.deepEqual(loaded.mainSections[1].table, emptyLayout.table)
  assert.deepEqual(roundTrip(loaded), loaded)
  const legacy = parseSummaryMeta(JSON.stringify([untitledTable, untitledParent]))
  assert.equal(legacy.sections.length, 2)
  assert.deepEqual(roundTrip(legacy), legacy)
})

test("Truly empty sections and malformed table-only values are not promoted into valid content", () => {
  const empty = { title: "", info: "", blocks: [], table: [] }
  const malformed = { title: "", info: "", blocks: [], table: ["not a row"] }
  const loaded = parseSummaryMeta(JSON.stringify({ sections: [empty, malformed], main_sections: [empty, malformed] }))
  assert.deepEqual(loaded.sections, [])
  assert.deepEqual(loaded.mainSections, [])
  assert.deepEqual(parseSummaryMeta(JSON.stringify([empty, malformed])).sections, [])
})
