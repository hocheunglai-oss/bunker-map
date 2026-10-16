"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { appendTaiwanNotice, TAIWAN_NOTICE_TEMPLATES, TAIWAN_NOTICE_TEMPLATE_GROUPS, validateTaiwanNoticeDraft } from "@/lib/taiwanNoticeTemplates"
import { captureTaiwanRemarkBaselines, confirmedTaiwanRemarksSave, type TaiwanRemarkBaseline, type TaiwanRemarkChange } from "@/lib/taiwanRemarksSave"
import {
  buildTaiwanOperationalNoticeMessage,
  emptyTaiwanOperationalNotice,
  normaliseTaiwanOperationalNotice,
  parseTaiwanOperationalNotice,
  serializeTaiwanOperationalNotice,
  TAIWAN_OPERATIONAL_NOTICE_REMARK_ID,
  type TaiwanOperationalNotice,
} from "@/lib/taiwanOperationalNotice"

function createEmptyMemo() {
  return { id: crypto.randomUUID(), text: "" }
}

class TaiwanRemarksSaveError extends Error {}

const pillButtonStyle: React.CSSProperties = {
  padding: "9px 14px",
  minWidth: "110px",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  textDecoration: "none",
  fontSize: "13px",
  fontWeight: 700,
  boxShadow: "none",
}

const memoCardStyle: React.CSSProperties = {
  background:
    "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border-soft)",
  borderRadius: "22px",
  padding: "18px",
  display: "grid",
  gap: "14px",
  boxShadow: "0 12px 28px #00000010",
}

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "120px",
  padding: "16px 18px",
  fontSize: "15px",
  lineHeight: 1.6,
  borderRadius: "16px",
  border: "1px solid var(--fc-admin-border)",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-admin-panel-text)",
  resize: "vertical",
  outline: "none",
  fontFamily: "var(--fc-admin-font)",
  boxSizing: "border-box",
  boxShadow: "none",
}

export default function AdminRemarks() {
  const [memos, setMemos] = useState<Array<{ id: string; text: string }>>([])
  const [specialNotice, setSpecialNotice] = useState<string>("")
  const [operationalNotice, setOperationalNotice] = useState<TaiwanOperationalNotice>(emptyTaiwanOperationalNotice)
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)
  const [message, setMessage] = useState<string>("")
  const [isDirty, setIsDirty] = useState<boolean>(false)
  const [noticeDirty, setNoticeDirty] = useState<boolean>(false)
  const [operationalNoticeDirty, setOperationalNoticeDirty] = useState<boolean>(false)
  const [loadError, setLoadError] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [baselines, setBaselines] = useState<TaiwanRemarkBaseline[] | null>(null)
  const [conflicted, setConflicted] = useState(false)
  const saveRequestRef = useRef<{ pending: boolean; generation: number } | null>(null)
  const generationRef = useRef(0)
  const [templateId, setTemplateId] = useState("")
  const [templateDraft, setTemplateDraft] = useState("")
  const [templateMessage, setTemplateMessage] = useState("")
  const { loading: adminLoading, authenticated, role, permissions } = useSimpleAdminAuth()
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "taiwan-remarks", "edit")
  const selectedTemplate = TAIWAN_NOTICE_TEMPLATES.find((item) => item.id === templateId)
  const hasUnsavedChanges = isDirty || noticeDirty || operationalNoticeDirty
  const operationalNoticePreview = buildTaiwanOperationalNoticeMessage(operationalNotice)

  useEffect(() => {
    let cancelled = false
    const generation = ++generationRef.current
    const loadRemark = async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const { data: remarksData, error } = await supabase
          .from("remarks")
          .select("*")
          .in("id", [1, 2, TAIWAN_OPERATIONAL_NOTICE_REMARK_ID])
        if (error || !Array.isArray(remarksData)) throw new Error("Could not load remarks")
        const loadedBaselines = captureTaiwanRemarkBaselines(remarksData)
        if (cancelled) return

        const remarkData = remarksData.find((item) => item.id === 1)
        const noticeData = remarksData.find((item) => item.id === 2)
        const operationalNoticeData = remarksData.find(
          (item) => item.id === TAIWAN_OPERATIONAL_NOTICE_REMARK_ID,
        )

        const initialMemos =
          remarkData?.content
            ?.split(/\n+/)
            .map((item: string) => item.trim())
            .filter(Boolean)
            .map((text: string) => ({ id: crypto.randomUUID(), text })) || []

        setMemos(initialMemos.length > 0 ? initialMemos : [createEmptyMemo()])
        setSpecialNotice(noticeData?.content || "")
        setOperationalNotice(parseTaiwanOperationalNotice(operationalNoticeData?.content))
        setBaselines(loadedBaselines)
        setConflicted(false)
        setIsDirty(false)
        setNoticeDirty(false)
        setOperationalNoticeDirty(false)
      } catch {
        if (!cancelled) setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    if (!adminLoading && authenticated) {
      loadRemark()
    }
    return () => {
      cancelled = true
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [adminLoading, authenticated, loadAttempt])

  const serializedRemark = useMemo(() => {
    return memos
      .map((memo) => memo.text.trim())
      .filter(Boolean)
      .join("\n")
  }, [memos])

  const saveRemark = async () => {
    if (!canEdit || saveRequestRef.current?.pending || loading || loadError || conflicted || !hasUnsavedChanges || !baselines) return
    const pendingContent = [noticeDirty ? specialNotice : "", isDirty ? serializedRemark : ""].filter((text) => text.trim())
    if (pendingContent.some((text) => validateTaiwanNoticeDraft(text))) {
      setMessage("Error: Replace the date, period or charge placeholders before saving.")
      return
    }
    setSaving(true)
    setMessage("")
    const request = { pending: true, generation: generationRef.current }
    saveRequestRef.current = request
    const isCurrent = () => saveRequestRef.current === request && request.generation === generationRef.current
    try {
      const rows: Array<{ id: 1 | 2 | 3; content: string }> = []
      if (isDirty) rows.push({ id: 1, content: serializedRemark })
      if (noticeDirty) rows.push({ id: 2, content: specialNotice.trim() })
      if (operationalNoticeDirty) rows.push({
        id: TAIWAN_OPERATIONAL_NOTICE_REMARK_ID,
        content: serializeTaiwanOperationalNotice(operationalNotice),
      })
      const changes: TaiwanRemarkChange[] = rows.map(row => {
        const expected = baselines.find(baseline => baseline.id === row.id)
        if (!expected) throw new TaiwanRemarksSaveError("Reload the saved remarks before saving. Your draft is still here.")
        return { ...row, expected }
      })
      const response = await fetch("/api/admin/taiwan-remarks", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }),
      })
      const result = await response.json().catch(() => null)
      if (!isCurrent()) return
      if (!response.ok) {
        if (result?.code === "REMARKS_CONFLICT") setConflicted(true)
        throw new TaiwanRemarksSaveError(result?.message || "Error saving remarks. Your draft is still here; please try again.")
      }
      if (!confirmedTaiwanRemarksSave(result, changes)) throw new TaiwanRemarksSaveError("The save could not be confirmed. Your draft is still here; retry to check whether it was saved.")
      {
        setBaselines(current => current?.map(baseline => {
          const saved = result.rows.find(row => row.id === baseline.id)
          return saved ? { id: saved.id, exists: true, content: saved.content } : baseline
        }) ?? null)
        setMessage(isDirty ? "Remarks saved. Open Taiwan Price History and choose Publish to update the report remarks." : "Remarks saved successfully")
        setIsDirty(false)
        setNoticeDirty(false)
        setOperationalNoticeDirty(false)
      }
    } catch (error) {
      if (isCurrent()) setMessage(error instanceof TaiwanRemarksSaveError ? error.message : "The save could not be confirmed. Your draft is still here; retry to check whether it was saved.")
    } finally {
      if (isCurrent()) {
        request.pending = false
        setSaving(false)
      }
    }
  }

  function reloadSavedRemarks() {
    if (saveRequestRef.current?.pending) return
    if (hasUnsavedChanges && !window.confirm("Discard your unsaved remark edits and reload the latest saved remarks?")) return
    setMessage("")
    setLoadAttempt(attempt => attempt + 1)
  }

  function selectTemplate(id: string) {
    if (saveRequestRef.current?.pending) return
    if (templateDraft !== (selectedTemplate?.text || "") && templateDraft.trim()
      && !window.confirm("Replace your edited template draft? Existing notices will not change.")) return
    setTemplateId(id)
    setTemplateDraft(TAIWAN_NOTICE_TEMPLATES.find((item) => item.id === id)?.text || "")
    setTemplateMessage("")
  }

  function insertTemplate(destination: "notice" | "remark") {
    if (!canEdit || saveRequestRef.current?.pending) return
    const error = validateTaiwanNoticeDraft(templateDraft)
    if (error) { setTemplateMessage(error); return }
    const appended = appendTaiwanNotice(destination === "notice" ? specialNotice : serializedRemark, templateDraft)
    if (!appended.added) { setTemplateMessage("This wording is already included."); return }
    if (destination === "notice") updateSpecialNotice(appended.text)
    else {
      // Keep existing cards; add only the new text, replacing an unused blank card.
      const newText = appended.text.slice(serializedRemark.trimEnd().length).trim()
      setMemos((prev) => [...prev.filter((memo) => memo.text.trim()), { id: crypto.randomUUID(), text: newText }])
      setIsDirty(true)
      setMessage("")
    }
    setTemplateMessage(destination === "notice"
      ? "Added to Special Notice. Review the wording, then Save. Refresh the Taiwan report to see it."
      : "Added to remarks. Review the wording, then Save. Open Taiwan Price History and choose Publish to update the report remarks.")
  }

  function updateMemo(id: string, value: string) {
    if (saveRequestRef.current?.pending) return
    setMemos((prev) => prev.map((memo) => (memo.id === id ? { ...memo, text: value } : memo)))
    setMessage("")
    setIsDirty(true)
  }

  function addMemo() {
    if (saveRequestRef.current?.pending) return
    setMemos((prev) => [...prev, createEmptyMemo()])
    setMessage("")
    setIsDirty(true)
  }

  function removeMemo(id: string) {
    if (saveRequestRef.current?.pending) return
    setMemos((prev) => {
      const next = prev.filter((memo) => memo.id !== id)
      return next.length > 0 ? next : [createEmptyMemo()]
    })
    setMessage("")
    setIsDirty(true)
  }

  function updateSpecialNotice(value: string) {
    if (saveRequestRef.current?.pending) return
    setSpecialNotice(value)
    setMessage("")
    setNoticeDirty(true)
  }

  function clearSpecialNotice() {
    if (saveRequestRef.current?.pending) return
    setSpecialNotice("")
    setMessage("")
    setNoticeDirty(true)
  }

  function updateOperationalNotice(next: Partial<TaiwanOperationalNotice>) {
    if (saveRequestRef.current?.pending) return
    setOperationalNotice((prev) => normaliseTaiwanOperationalNotice({ ...prev, ...next }))
    setMessage("")
    setOperationalNoticeDirty(true)
  }

  function clearOperationalNotice() {
    if (saveRequestRef.current?.pending) return
    setOperationalNotice(emptyTaiwanOperationalNotice)
    setMessage("")
    setOperationalNoticeDirty(true)
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading || loading) return <p style={{ padding: "40px" }}>Loading...</p>
  if (loadError) return <div role="alert" style={{ padding: "40px" }}>
    <p>Could not load the existing remarks. Nothing has been changed.</p>
    <button onClick={() => setLoadAttempt((attempt) => attempt + 1)} style={pillButtonStyle}>Try again</button>
  </div>

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "var(--fc-admin-page-bg)",
        padding: "24px",
        fontFamily: "var(--fc-admin-font)",
        color: "var(--fc-admin-panel-text)",
      }}
    >
      <div
        style={{
          maxWidth: "980px",
          margin: "0 auto",
          background: "var(--fc-admin-panel-bg)",
          border: "1px solid var(--fc-admin-border)",
          borderRadius: "24px",
          padding: "22px",
          boxShadow: "0 18px 42px #00000012",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: "0",
            zIndex: 20,
            margin: "-22px -22px 20px",
            padding: "18px 22px 14px",
            background: "var(--fc-admin-panel-bg)",
            borderBottom: "1px solid var(--fc-admin-border-soft)",
            borderTopLeftRadius: "24px",
            borderTopRightRadius: "24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <button
              onClick={addMemo}
              disabled={!canEdit || saving}
              style={{
                ...pillButtonStyle,
                background: "var(--fc-admin-primary-button-bg)",
                border: "1px solid var(--fc-admin-selected-border)",
                color: "var(--fc-admin-primary-button-text)",
                cursor: "pointer",
              }}
              aria-label="Add remark"
            >
              Add Remark
            </button>

            <button
              onClick={saveRemark}
              disabled={!canEdit || saving || conflicted || !hasUnsavedChanges}
              style={{
                ...pillButtonStyle,
                background: isDirty || noticeDirty
                  ? "var(--fc-admin-success-bg)"
                  : "var(--fc-admin-success-bg)",
                color: "var(--fc-admin-success-text)",
                textTransform: "uppercase",
                border: hasUnsavedChanges ? "1px solid var(--fc-admin-success-border)" : "1px solid var(--fc-admin-success-border)",
                cursor: saving ? "wait" : "pointer",
              }}
            >
              {saving ? "Saving..." : hasUnsavedChanges ? "Save" : "Saved"}
            </button>
          </div>
          <div role="status" style={{ fontSize: "13px" }}>
            {!canEdit ? "View only" : message || (hasUnsavedChanges ? "Unsaved changes" : "")}
          </div>
          {conflicted ? <button type="button" onClick={reloadSavedRemarks} disabled={saving} style={pillButtonStyle}>Reload saved remarks</button> : null}
        </div>

        <div style={{ ...memoCardStyle, marginBottom: "14px", fontSize: "13px", lineHeight: 1.6 }}>
          <p style={{ margin: 0 }}>Remarks: Save here first, then open Taiwan Price History and choose Publish. The report keeps its previously published remarks and saved quote date until you publish.</p>
          <p style={{ margin: 0 }}>Special Notice and typhoon settings: Save here, then refresh the Taiwan report. No separate Publish is needed for these notices.</p>
          <a href="/admin/taiwanpricehistory" aria-disabled={saving || hasUnsavedChanges}
            onClick={event => { if (saving || hasUnsavedChanges) { event.preventDefault(); setMessage("Save your remark changes before opening Taiwan Price History.") } }}
            style={{ color: "var(--fc-admin-selected-text)", fontWeight: 700 }}>
            Open Taiwan Price History → Publish
          </a>
        </div>

        <fieldset disabled={!canEdit || saving} style={{ display: "grid", gap: "14px", margin: 0, padding: 0, border: 0, minWidth: 0 }}>
          <details style={memoCardStyle}>
            <summary style={{ cursor: "pointer", fontWeight: 800 }}>Notice templates · {TAIWAN_NOTICE_TEMPLATES.length} choices</summary>
            <div style={{ display: "grid", gap: "12px", marginTop: "14px" }}>
              <p style={{ margin: 0, fontSize: "13px" }}>Reference wording only. Check the current port, product, dates and charges. Adding a template keeps existing text. Save Special Notice here; for report remarks, Save then Publish in Taiwan Price History.</p>
              <label style={{ display: "grid", gap: "6px", fontWeight: 700 }}>
                Choose a template
                <select value={templateId} onChange={(event) => selectTemplate(event.target.value)} style={{ ...textareaStyle, minHeight: "auto", padding: "12px" }}>
                  <option value="">Select a notice...</option>
                  {TAIWAN_NOTICE_TEMPLATE_GROUPS.map((group) => <optgroup key={group} label={group}>
                    {TAIWAN_NOTICE_TEMPLATES.filter((item) => item.group === group).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </optgroup>)}
                </select>
              </label>
              {selectedTemplate && <>
                <p style={{ margin: 0, fontSize: "13px" }}>{selectedTemplate.guidance || "Replace any [PLACEHOLDERS] with confirmed details, including the year. These examples do not confirm current availability."}</p>
                <label style={{ display: "grid", gap: "6px", fontWeight: 700 }}>
                  Edit template wording
                  <textarea value={templateDraft} onChange={(event) => { setTemplateDraft(event.target.value); setTemplateMessage("") }} style={textareaStyle} />
                </label>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button onClick={() => insertTemplate("notice")} style={pillButtonStyle}>Add to Special Notice</button>
                  <button onClick={() => insertTemplate("remark")} style={pillButtonStyle}>Add as Remark</button>
                </div>
                {templateMessage && <p role="status" style={{ margin: 0, fontSize: "13px" }}>{templateMessage}</p>}
              </>}
            </div>
          </details>
          <div
            style={{
              ...memoCardStyle,
              border: "1px solid var(--fc-admin-warning-border)",
              background:
                "linear-gradient(180deg, rgba(94, 61, 22, 0.66) 0%, rgba(42, 36, 32, 0.52) 100%)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <div>
                <div
                  style={{
                    color: "var(--fc-admin-warning-text)",
                    fontSize: "12px",
                    fontWeight: 800,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                  }}
                >
                  Operational Notice
                </div>
                <div style={{ marginTop: "4px", color: "var(--fc-admin-warning-text)", fontSize: "12px" }}>
                  Input typhoon name and expected reopen date. The report uses the fixed typhoon notice template.
                </div>
              </div>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  onClick={clearOperationalNotice}
                  style={{
                    ...pillButtonStyle,
                    padding: "8px 12px",
                    border: "1px solid var(--fc-admin-danger-border)",
                    background: "var(--fc-admin-danger-bg)",
                    color: "var(--fc-admin-danger-text)",
                    cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "10px",
                color: "var(--fc-admin-warning-text)",
                fontSize: "13px",
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              <input
                type="checkbox"
                checked={operationalNotice.active}
                onChange={(event) => updateOperationalNotice({ active: event.target.checked })}
              />
              Show On Taiwan Report
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
              <label style={{ display: "grid", gap: "7px", color: "var(--fc-admin-warning-text)", fontSize: "12px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Typhoon Name
                <input
                  style={{
                    ...textareaStyle,
                    minHeight: "auto",
                    padding: "12px 14px",
                    border: "1px solid var(--fc-admin-warning-border)",
                    background: "var(--fc-admin-warning-bg)",
                  }}
                  value={operationalNotice.typhoonName}
                  onChange={(event) => updateOperationalNotice({ typhoonName: event.target.value })}
                  placeholder="Bavi"
                />
              </label>

              <label style={{ display: "grid", gap: "7px", color: "var(--fc-admin-warning-text)", fontSize: "12px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Expected Reopen Date
                <input
                  style={{
                    ...textareaStyle,
                    minHeight: "auto",
                    padding: "12px 14px",
                    border: "1px solid var(--fc-admin-warning-border)",
                    background: "var(--fc-admin-warning-bg)",
                  }}
                  value={operationalNotice.expectedReopenDate}
                  onChange={(event) => updateOperationalNotice({ expectedReopenDate: event.target.value })}
                  placeholder="next Monday, 13 Jul"
                />
              </label>
            </div>

            <div
              style={{
                ...textareaStyle,
                minHeight: "132px",
                border: "1px solid var(--fc-admin-warning-border)",
                background: "var(--fc-admin-warning-bg)",
                whiteSpace: "pre-line",
              }}
            >
              {operationalNoticePreview || "Preview will appear after both variables are entered."}
            </div>
          </div>

          <div
            style={{
              ...memoCardStyle,
              border: "1px solid var(--fc-admin-warning-border)",
              background:
                "var(--fc-admin-warning-bg)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <div>
                <div
                  style={{
                    color: "var(--fc-admin-warning-text)",
                    fontSize: "12px",
                    fontWeight: 800,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                  }}
                >
                  Special Notice
                </div>
                <div style={{ marginTop: "4px", color: "var(--fc-admin-warning-text)", fontSize: "12px" }}>
                  Appears only when text is entered.
                </div>
              </div>

              <button
                onClick={clearSpecialNotice}
                style={{
                  ...pillButtonStyle,
                  padding: "8px 12px",
                  border: "1px solid var(--fc-admin-warning-border)",
                  background: "var(--fc-admin-warning-bg)",
                  color: "var(--fc-admin-warning-text)",
                  cursor: "pointer",
                }}
              >
                Remove Notice
              </button>
            </div>

            <textarea
              style={{
                ...textareaStyle,
                border: "1px solid var(--fc-admin-warning-border)",
                background: "var(--fc-admin-warning-bg)",
              }}
              value={specialNotice}
              aria-label="Special Notice"
              onChange={(e) => updateSpecialNotice(e.target.value)}
              placeholder="Write a short Taiwan special notice..."
            />
          </div>

          {memos.map((memo, index) => (
            <div
              key={memo.id}
              style={memoCardStyle}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0",
                  }}
                >
                  <span
                    style={{
                      width: "30px",
                      height: "30px",
                      borderRadius: "999px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "var(--fc-admin-selected-bg)",
                      border: "1px solid var(--fc-admin-selected-border)",
                      color: "var(--fc-admin-panel-text)",
                      fontSize: "12px",
                      fontWeight: 800,
                      boxShadow: "inset 0 1px 0 var(--fc-admin-border-soft)",
                    }}
                  >
                    {index + 1}
                  </span>
                </div>

                <button
                  onClick={() => removeMemo(memo.id)}
                  style={{
                    ...pillButtonStyle,
                    padding: "8px 12px",
                    border: "1px solid var(--fc-admin-danger-border)",
                    background: "var(--fc-admin-danger-bg)",
                    color: "var(--fc-admin-danger-text)",
                    cursor: "pointer",
                  }}
                >
                  Remove
                </button>
              </div>

              <textarea
                style={textareaStyle}
                value={memo.text}
                aria-label={`Remark ${index + 1}`}
                onChange={(e) => updateMemo(memo.id, e.target.value)}
                placeholder="Write a concise Taiwan market remark..."
              />
            </div>
          ))}

          {message && (
            <p
              style={{
                margin: 0,
                fontWeight: 600,
                color: message.includes("Error") ? "var(--fc-admin-danger-text)" : "var(--fc-admin-panel-text)",
              }}
            >
              {message}
            </p>
          )}
        </fieldset>
      </div>
    </div>
  )
}
