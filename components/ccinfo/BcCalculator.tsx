"use client"

import { useState } from "react"
import { BC_FACTOR, calculateBc, normalizeBcCalculator, type BcCalculatorValues } from "@/lib/bcCalculator"

type Props = {
  value: BcCalculatorValues | undefined
  savedValue: BcCalculatorValues | undefined
  saving: boolean
  onChange: (value: BcCalculatorValues) => void
  onSave: () => Promise<void>
}

const input: React.CSSProperties = {
  width: "100%", minWidth: 0, border: "1px solid var(--fc-admin-border)", borderRadius: 9,
  padding: "10px 9px", background: "var(--fc-tool-input-bg)", color: "var(--fc-admin-panel-text)",
  fontSize: 16, fontVariantNumeric: "tabular-nums", scrollMarginInlineStart: 128, scrollMarginInlineEnd: 8, scrollMarginTop: 160,
}
const cellStyle: React.CSSProperties = {
  padding: 8, borderTop: "1px solid var(--fc-admin-border-soft)", borderRight: "1px solid var(--fc-admin-border-soft)",
}
const rowHeaderStyle: React.CSSProperties = {
  ...cellStyle, position: "sticky", left: 0, zIndex: 1, textAlign: "left", padding: "12px 10px",
  background: "var(--fc-admin-panel-soft-bg)", color: "var(--fc-admin-panel-text)", fontSize: 12, fontWeight: 700,
}
const format = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value)

export default function BcCalculator({ value, savedValue, saving, onChange, onSave }: Props) {
  const draft = normalizeBcCalculator(value)
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle")
  const result = calculateBc(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(normalizeBcCalculator(savedValue))
  const isSaving = saving || status === "saving"
  const setGrade = (index: number, field: "quantity" | "buy" | "sell", next: string) => {
    onChange({ ...draft, grades: draft.grades.map((grade, gradeIndex) => gradeIndex === index ? { ...grade, [field]: next } : grade) as BcCalculatorValues["grades"] })
  }
  const numeric = (label: string, current: string, change: (value: string) => void) => (
    <input
      aria-label={label} type="number" inputMode="decimal" step="any" value={current}
      onChange={(event) => change(event.target.value)} style={input}
      onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return
        event.preventDefault()
        const fields = Array.from(event.currentTarget.closest("table")?.querySelectorAll<HTMLInputElement>("input") || [])
        fields[fields.indexOf(event.currentTarget) + (event.shiftKey ? -1 : 1)]?.focus()
      }}
    />
  )
  const save = async () => {
    setStatus("saving")
    try {
      await onSave()
      setStatus("idle")
    } catch {
      setStatus("error")
    }
  }
  const rows = [
    { label: "QUANTITY", field: "quantity" as const },
    { label: "INITIAL PRICE", field: "buy" as const },
    { label: "FINAL PRICE", field: "sell" as const },
  ]

  return (
    <section aria-label="BC CALCULATOR" style={{ display: "grid", gap: 14, maxWidth: 1100, minWidth: 0 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18, color: "var(--fc-admin-panel-text)" }}>BC CALCULATOR</h2>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fc-admin-muted)", lineHeight: 1.5 }}>ENTER QUANTITIES ACROSS, THEN INITIAL PRICE AND FINAL PRICE. USE TAB OR ENTER TO MOVE ACROSS.</p>
      </div>
      <div role="region" aria-label="BC INPUT TABLE — SCROLL HORIZONTALLY TO VIEW ALL GRADES" tabIndex={0} style={{ maxWidth: "100%", minWidth: 0, overflowX: "auto", border: "1px solid var(--fc-admin-border)", borderRadius: 12, background: "var(--fc-admin-panel-bg)" }}>
        <table aria-label="BC INPUTS" style={{ width: "100%", minWidth: 632, tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0 }}>
          <colgroup><col style={{ width: 120 }} /><col /><col /><col /><col /></colgroup>
          <thead>
            <tr>
              <th scope="col" style={{ ...rowHeaderStyle, borderTop: 0 }}>FIELD</th>
              {["GRADE 1", "GRADE 2", "GRADE 3", "LUMPSUM"].map((label) => (
                <th key={label} scope="col" style={{ ...cellStyle, borderTop: 0, padding: "13px 8px", background: "var(--fc-admin-panel-soft-bg)", color: "var(--fc-admin-link)", fontSize: 12, fontWeight: 800 }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, field }) => (
              <tr key={field}>
                <th scope="row" style={rowHeaderStyle}>{label}</th>
                {draft.grades.map((grade, index) => (
                  <td key={index} style={cellStyle}>{numeric(`GRADE ${index + 1} ${label}`, grade[field], (next) => setGrade(index, field, next))}</td>
                ))}
                <td style={cellStyle}>
                  {field === "quantity" ? <span aria-label="NOT APPLICABLE" style={{ display: "block", textAlign: "center", color: "var(--fc-admin-muted)" }}>—</span> : numeric(`LUMPSUM ${label}`, field === "buy" ? draft.lumpsumBuy : draft.lumpsumSell, (next) => onChange({ ...draft, [field === "buy" ? "lumpsumBuy" : "lumpsumSell"]: next }))}
                </td>
              </tr>
            ))}
            <tr style={{ background: "var(--fc-admin-selected-bg)", color: "var(--fc-admin-panel-text)", fontVariantNumeric: "tabular-nums" }}>
              <th scope="row" style={{ ...rowHeaderStyle, background: "var(--fc-admin-selected-bg)" }}>BC</th>
              {draft.grades.map((_, index) => (
                <td key={index} style={{ ...cellStyle, padding: "14px 8px", textAlign: "center", fontWeight: 800 }}><output aria-label={`GRADE ${index + 1} BC`} aria-live="off">{result.bc === null || result.quantities[index] <= 0 ? "—" : format(result.bc)}</output></td>
              ))}
              <td style={{ ...cellStyle, textAlign: "center", color: "var(--fc-admin-muted)" }}>—</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 12, color: "var(--fc-admin-muted)" }}>TOTAL QUANTITY · {format(result.totalQuantity)}</div>
        <div style={{ fontSize: 12, color: "var(--fc-admin-muted)" }}>TOTAL MARGIN · {result.valid ? format(result.totalMargin) : "—"}</div>
        <div style={{ fontSize: 12, color: "var(--fc-admin-muted)" }}>BASE BC · {result.baseBc === null ? "—" : format(result.baseBc)}</div>
        <div role="status" aria-live="polite" style={{ fontSize: 24, fontWeight: 800, color: "var(--fc-admin-panel-text)", fontVariantNumeric: "tabular-nums" }}>
          BC · {result.bc === null ? "—" : format(result.bc)}
        </div>
        {result.totalQuantity <= 0 && <div style={{ fontSize: 12, color: "var(--fc-admin-muted)" }}>ENTER A POSITIVE GRADE QUANTITY TO CALCULATE BC.</div>}
        {!result.valid && <div style={{ fontSize: 12, color: "var(--fc-admin-danger-border)" }}>ENTER INITIAL PRICE AND FINAL PRICE FOR EVERY GRADE WITH A QUANTITY, USING NONNEGATIVE QUANTITIES.</div>}
        <div style={{ fontSize: 11, color: "var(--fc-admin-muted)", lineHeight: 1.5 }}>BC = [Σ((FINAL PRICE − INITIAL PRICE) × QUANTITY) + LUMPSUM (FINAL PRICE − INITIAL PRICE)] ÷ TOTAL GRADE QUANTITY × {BC_FACTOR}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void save()} disabled={!dirty || !result.valid || isSaving} style={{ border: 0, borderRadius: 999, padding: "9px 18px", background: "var(--fc-admin-primary-button-bg)", color: "var(--fc-admin-primary-button-text)", fontWeight: 700, cursor: "pointer", opacity: !dirty || !result.valid || isSaving ? 0.55 : 1 }}>SAVE CALCULATOR</button>
        <span role="status" style={{ fontSize: 12, color: status === "error" && dirty ? "var(--fc-admin-danger-border)" : "var(--fc-admin-muted)" }}>{isSaving ? "SAVING…" : !dirty ? "SAVED" : status === "error" ? "COULD NOT SAVE. YOUR VALUES ARE STILL HERE; TRY AGAIN." : "UNSAVED CHANGES"}</span>
      </div>
    </section>
  )
}
