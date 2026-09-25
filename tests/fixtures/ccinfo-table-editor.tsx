import React, { useState } from "react"
import { createRoot } from "react-dom/client"
import SimpleTable from "../../components/ccinfo/SimpleTable"

type TableSnapshot = { table: string[][]; columnWidths: number[]; rowUpdates: string[] }
type TableHarness = {
  current: TableSnapshot
  baseline: TableSnapshot
  calls: number
  saved: TableSnapshot[]
  failNext: boolean
  deferSave: boolean
  releaseSave: (() => void) | null
}

declare global {
  interface Window { __ccinfoTableHarness: TableHarness }
}

const headings = ["Supplier", "HSFO", "VLSFO", "LSMGO", "MFM", "Contact", "Remarks", "Notes"]
const baseline: TableSnapshot = {
  table: [headings, ...Array.from({ length: 80 }, (_, index) => [
    `Supplier ${String(index + 1).padStart(3, "0")}`, "Y", index % 2 ? "" : "Y", "Y", "", `Desk ${index + 1}`, `Remark ${index + 1}`, "",
  ])],
  columnWidths: [22, 8, 8, 8, 8, 14, 20, 12],
  rowUpdates: Array.from({ length: 81 }, () => "2026-09-24T01:00:00.000Z"),
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

window.__ccinfoTableHarness = {
  current: clone(baseline), baseline: clone(baseline), calls: 0, saved: [],
  failNext: false, deferSave: false, releaseSave: null,
}

function Fixture() {
  const [snapshot, setSnapshot] = useState<TableSnapshot>(() => clone(baseline))
  const readOnly = new URLSearchParams(location.search).get("readOnly") === "1"
  async function save(table: string[][], columnWidths: number[], rowUpdates: string[]) {
    const harness = window.__ccinfoTableHarness
    harness.calls += 1
    const next = clone({ table, columnWidths, rowUpdates })
    if (harness.deferSave) {
      await new Promise<void>((resolve) => { harness.releaseSave = resolve })
      harness.releaseSave = null
    }
    if (harness.failNext) {
      harness.failNext = false
      throw new Error("Simulated save failure. Please retry.")
    }
    harness.saved.push(next)
    harness.current = clone(next)
    setSnapshot(next)
  }
  return (
    <main style={{ maxWidth: "980px", margin: "0 auto", padding: "20px" }}>
      <h1>CCINFO table editor — local regression fixture</h1>
      <p>Only synthetic data is used. Saving updates this page's memory only.</p>
      <SimpleTable title="Supplier characteristics" table={snapshot.table} columnWidths={snapshot.columnWidths} rowUpdates={snapshot.rowUpdates} onSave={save} readOnly={readOnly} />
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
