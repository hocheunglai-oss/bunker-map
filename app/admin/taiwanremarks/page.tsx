"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

function createEmptyMemo() {
  return { id: crypto.randomUUID(), text: "" }
}

const pillButtonStyle: React.CSSProperties = {
  padding: "9px 14px",
  border: "1px solid rgba(210,236,255,0.16)",
  borderRadius: "999px",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontSize: "13px",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(8,24,44,0.16)",
}

const memoCardStyle: React.CSSProperties = {
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.14), transparent 32%), linear-gradient(180deg, rgba(14, 43, 70, 0.94) 0%, rgba(7, 26, 44, 0.9) 100%)",
  border: "1px solid rgba(173, 216, 255, 0.14)",
  borderRadius: "22px",
  padding: "18px",
  display: "grid",
  gap: "14px",
  boxShadow: "0 18px 40px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255,255,255,0.05)",
}

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "120px",
  padding: "16px 18px",
  fontSize: "15px",
  lineHeight: 1.6,
  borderRadius: "16px",
  border: "1px solid rgba(173, 216, 255, 0.18)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.04) 100%)",
  color: "#edf7ff",
  resize: "vertical",
  outline: "none",
  fontFamily: "Arial, Helvetica, sans-serif",
  boxSizing: "border-box",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
}

export default function AdminRemarks() {
  const [memos, setMemos] = useState<Array<{ id: string; text: string }>>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)
  const [message, setMessage] = useState<string>("")
  const [isDirty, setIsDirty] = useState<boolean>(false)
  const { loading: adminLoading, authenticated } = useSimpleAdminAuth()

  useEffect(() => {
    const loadRemark = async () => {
      const { data: remarkData } = await supabase
        .from("remarks")
        .select("*")
        .eq("id", 1)
        .maybeSingle()

      const initialMemos =
        remarkData?.content
          ?.split(/\n+/)
          .map((item: string) => item.trim())
          .filter(Boolean)
          .map((text: string) => ({ id: crypto.randomUUID(), text })) || []

      setMemos(initialMemos.length > 0 ? initialMemos : [createEmptyMemo()])
      setIsDirty(false)
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
      .upsert({ id: 1, content: serializedRemark })

    if (error) setMessage("Error saving remarks")
    else {
      setMessage("Remarks saved successfully")
      setIsDirty(false)
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

  if (!adminLoading && !authenticated) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (adminLoading || loading) return <p style={{ padding: "40px" }}>Loading...</p>

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #114a80 0%, #0a2c4c 34%, #041629 100%)",
        padding: "24px",
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#edf7ff",
      }}
    >
      <div
        style={{
          maxWidth: "980px",
          margin: "0 auto",
          background: "rgba(6, 24, 44, 0.68)",
          border: "1px solid rgba(210, 236, 255, 0.16)",
          borderRadius: "24px",
          padding: "22px",
          backdropFilter: "blur(18px)",
          WebkitBackdropFilter: "blur(18px)",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.24)",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: "0",
            zIndex: 20,
            margin: "-22px -22px 20px",
            padding: "18px 22px 14px",
            background: "rgba(6, 24, 44, 0.92)",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
            borderBottom: "1px solid rgba(210, 236, 255, 0.14)",
            borderTopLeftRadius: "24px",
            borderTopRightRadius: "24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          <h1
            style={{
              fontSize: "30px",
              margin: 0,
              lineHeight: 1,
              textTransform: "uppercase",
            }}
          >
            Taiwan Market Report Remarks
          </h1>

            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <a
              href="/admin"
              style={pillButtonStyle}
            >
              ← Back To Admin
            </a>

            <button
              onClick={addMemo}
              style={{
                ...pillButtonStyle,
                background: "linear-gradient(180deg, rgba(72, 170, 255, 0.34) 0%, rgba(20, 112, 196, 0.18) 100%)",
                border: "1px solid rgba(80, 170, 255, 0.2)",
                color: "#e2f3ff",
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
                background: isDirty
                  ? "linear-gradient(180deg, rgba(56, 214, 154, 0.34) 0%, rgba(20, 130, 93, 0.16) 100%)"
                  : "linear-gradient(180deg, rgba(56, 214, 154, 0.2) 0%, rgba(20, 130, 93, 0.1) 100%)",
                color: "#ddffef",
                textTransform: "uppercase",
                border: isDirty ? "1px solid rgba(73, 219, 165, 0.32)" : "1px solid rgba(73, 219, 165, 0.22)",
                cursor: saving ? "wait" : "pointer",
              }}
            >
              {saving ? "Saving..." : isDirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gap: "14px" }}>
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
                      background: "linear-gradient(180deg, rgba(88, 182, 255, 0.24) 0%, rgba(28, 102, 168, 0.14) 100%)",
                      border: "1px solid rgba(141, 207, 255, 0.22)",
                      color: "#dff3ff",
                      fontSize: "12px",
                      fontWeight: 800,
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
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
                    border: "1px solid rgba(255, 120, 120, 0.18)",
                    background: "linear-gradient(180deg, rgba(230, 57, 70, 0.18) 0%, rgba(230, 57, 70, 0.1) 100%)",
                    color: "#ffd4d8",
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
                color: message.includes("Error") ? "#ff8c8c" : "#79e6b3",
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
