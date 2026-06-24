"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

function createEmptyMemo() {
  return { id: crypto.randomUUID(), text: "" }
}

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
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)
  const [message, setMessage] = useState<string>("")
  const [isDirty, setIsDirty] = useState<boolean>(false)
  const [noticeDirty, setNoticeDirty] = useState<boolean>(false)
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()

  useEffect(() => {
    const loadRemark = async () => {
      const { data: remarksData } = await supabase
        .from("remarks")
        .select("*")
        .in("id", [1, 2])

      const remarkData = remarksData?.find((item) => item.id === 1)
      const noticeData = remarksData?.find((item) => item.id === 2)

      const initialMemos =
        remarkData?.content
          ?.split(/\n+/)
          .map((item: string) => item.trim())
          .filter(Boolean)
          .map((text: string) => ({ id: crypto.randomUUID(), text })) || []

      setMemos(initialMemos.length > 0 ? initialMemos : [createEmptyMemo()])
      setSpecialNotice(noticeData?.content || "")
      setIsDirty(false)
      setNoticeDirty(false)
      setLoading(false)
    }

    if (!adminLoading && authenticated) {
      loadRemark()
    }
  }, [adminLoading, authenticated])

  const serializedRemark = useMemo(() => {
    return memos
      .map((memo) => memo.text.trim())
      .filter(Boolean)
      .join("\n")
  }, [memos])

  const saveRemark = async () => {
    setSaving(true)
    setMessage("")

    const { error } = await supabase
      .from("remarks")
      .upsert([
        { id: 1, content: serializedRemark },
        { id: 2, content: specialNotice.trim() },
      ])

    if (error) setMessage("Error saving remarks")
    else {
      setMessage("Remarks saved successfully")
      setIsDirty(false)
      setNoticeDirty(false)
    }

    setSaving(false)
  }

  function updateMemo(id: string, value: string) {
    setMemos((prev) => prev.map((memo) => (memo.id === id ? { ...memo, text: value } : memo)))
    setMessage("")
    setIsDirty(true)
  }

  function addMemo() {
    setMemos((prev) => [...prev, createEmptyMemo()])
    setMessage("")
    setIsDirty(true)
  }

  function removeMemo(id: string) {
    setMemos((prev) => {
      const next = prev.filter((memo) => memo.id !== id)
      return next.length > 0 ? next : [createEmptyMemo()]
    })
    setMessage("")
    setIsDirty(true)
  }

  function updateSpecialNotice(value: string) {
    setSpecialNotice(value)
    setMessage("")
    setNoticeDirty(true)
  }

  function clearSpecialNotice() {
    setSpecialNotice("")
    setMessage("")
    setNoticeDirty(true)
  }

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading || loading) return <p style={{ padding: "40px" }}>Loading...</p>

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
              disabled={saving}
              style={{
                ...pillButtonStyle,
                background: isDirty || noticeDirty
                  ? "var(--fc-admin-success-bg)"
                  : "var(--fc-admin-success-bg)",
                color: "var(--fc-admin-success-text)",
                textTransform: "uppercase",
                border: isDirty || noticeDirty ? "1px solid var(--fc-admin-success-border)" : "1px solid var(--fc-admin-success-border)",
                cursor: saving ? "wait" : "pointer",
              }}
            >
              {saving ? "Saving..." : isDirty || noticeDirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gap: "14px" }}>
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
                color: message.includes("Error") ? "var(--fc-admin-danger-text)" : "var(--fc-admin-success-text)",
              }}
            >
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
