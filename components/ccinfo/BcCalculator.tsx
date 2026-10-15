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

const card: React.CSSProperties = {
  border: "1px solid var(--fc-admin-border)", borderRadius: 14,
  background: "var(--fc-admin-panel-soft-bg)", padding: 16,
}
const input: React.CSSProperties = {
  width: "100%", minWidth: 0, border: "1px solid var(--fc-admin-border)", borderRadius: 9,
  padding: "10px 11px", background: "var(--fc-tool-input-bg)", color: "var(--fc-admin-panel-text)",
  fontSize: 16, fontVariantNumeric: "tabular-nums",
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
    <label style={{ display: "grid", gap: 6, minWidth: 0, fontSize: 12, fontWeight: 700, color: "var(--fc-admin-muted)" }}>
      {label}
      <input aria-label={label} type="number" inputMode="decimal" step="any" value={current} onChange={(event) => change(event.target.value)} style={input} />
    </label>
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

  return (
    <section aria-label="BC Calculator" style={{ display: "grid", gap: 14, maxWidth: 1100 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18, color: "var(--fc-admin-panel-text)" }}>BC Calculator</h2>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--fc-admin-muted)" }}>Enter each grade’s quantity, buy and sell, plus any lump sum buy and sell. BC updates as you type.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 215px), 1fr))", gap: 12 }}>
        {draft.grades.map((grade, index) => (
          <div key={index} style={{ ...card, display: "grid", gap: 11 }}>
            <h3 style={{ margin: 0, fontSize: 14, color: "var(--fc-admin-link)" }}>GRADE {index + 1}</h3>
            {numeric(`Grade ${index + 1} quantity`, grade.quantity, (next) => setGrade(index, "quantity", next))}
            {numeric(`Grade ${index + 1} buy`, grade.buy, (next) => setGrade(index, "buy", next))}
            {numeric(`Grade ${index + 1} sell`, grade.sell, (next) => setGrade(index, "sell", next))}
            <div style={{ borderTop: "1px solid var(--fc-admin-border-soft)", paddingTop: 9, fontSize: 12, color: "var(--fc-admin-panel-text)" }}>
              Sell − buy: <strong>{result.valid ? format(result.gradeMargins[index]) : "—"}</strong>
            </div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--fc-admin-panel-text)" }}>BC: {result.bc === null || result.quantities[index] <= 0 ? "—" : format(result.bc)}</div>
          </div>
        ))}
        <div style={{ ...card, display: "grid", gap: 11, alignContent: "start" }}>
          <h3 style={{ margin: 0, fontSize: 14, color: "var(--fc-admin-link)" }}>LUMPSUM</h3>
          {numeric("Lumpsum buy", draft.lumpsumBuy, (next) => onChange({ ...draft, lumpsumBuy: next }))}
          {numeric("Lumpsum sell", draft.lumpsumSell, (next) => onChange({ ...draft, lumpsumSell: next }))}
          <div style={{ borderTop: "1px solid var(--fc-admin-border-soft)", paddingTop: 9, fontSize: 12, color: "var(--fc-admin-panel-text)" }}>
            Sell − buy: <strong>{result.valid ? format(result.lumpsum) : "—"}</strong>
          </div>
        </div>
      </div>
      <div style={{ ...card, display: "grid", gap: 8, background: "var(--fc-admin-selected-bg)", borderColor: "var(--fc-admin-selected-border)" }}>
        <div style={{ fontSize: 12, color: "var(--fc-admin-muted)" }}>TOTAL QUANTITY · {format(result.totalQuantity)}</div>
        <div style={{ fontSize: 12, color: "var(--fc-admin-muted)" }}>TOTAL MARGIN · {result.valid ? format(result.totalMargin) : "—"}</div>
        <div style={{ fontSize: 12, color: "var(--fc-admin-muted)" }}>BASE BC · {result.baseBc === null ? "—" : format(result.baseBc)}</div>
        <div role="status" aria-live="polite" style={{ fontSize: 24, fontWeight: 800, color: "var(--fc-admin-panel-text)", fontVariantNumeric: "tabular-nums" }}>
          BC · {result.bc === null ? "—" : format(result.bc)}
        </div>
        {result.totalQuantity <= 0 && <div style={{ fontSize: 12, color: "var(--fc-admin-muted)" }}>Enter a positive grade quantity to calculate BC.</div>}
        {!result.valid && <div style={{ fontSize: 12, color: "var(--fc-admin-danger-border)" }}>Enter buy and sell for every grade with a quantity, using nonnegative quantities.</div>}
        <div style={{ fontSize: 11, color: "var(--fc-admin-muted)" }}>BC = [Σ((sell − buy) × quantity) + (lumpsum sell − buy)] ÷ total grade quantity × {BC_FACTOR}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void save()} disabled={!dirty || !result.valid || isSaving} style={{ border: 0, borderRadius: 999, padding: "9px 18px", background: "var(--fc-admin-primary-button-bg)", color: "var(--fc-admin-primary-button-text)", fontWeight: 700, cursor: "pointer", opacity: !dirty || !result.valid || isSaving ? 0.55 : 1 }}>Save calculator</button>
        <span role="status" style={{ fontSize: 12, color: status === "error" && dirty ? "var(--fc-admin-danger-border)" : "var(--fc-admin-muted)" }}>{isSaving ? "Saving…" : !dirty ? "Saved" : status === "error" ? "Could not save. Your values are still here; try again." : "Unsaved changes"}</span>
      </div>
    </section>
  )
}
