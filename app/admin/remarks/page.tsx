"use client"

import { useEffect, useState } from "react"
import { supabase } from "../../../lib/supabase"

export default function AdminRemarks() {
  const [remark, setRemark] = useState<string>("")
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)
  const [message, setMessage] = useState<string>("")

  useEffect(() => {
    const loadRemark = async () => {
      setLoading(true)
      const { data, error } = await supabase
        .from("remarks")
        .select("*")
        .limit(1)
        .single()

      if (error) {
        console.error("Error loading remark:", error)
        setRemark("")
      } else if (data) {
        setRemark(data.content)
      }
      setLoading(false)
    }

    loadRemark()
  }, [])

  const saveRemark = async () => {
    setSaving(true)
    setMessage("")
    const { error } = await supabase
      .from("remarks")
      .upsert({ id: 1, content: remark })
    if (error) {
      console.error("Error saving remark:", error)
      setMessage("Error saving remark")
    } else {
      setMessage("Remark saved successfully!")
    }
    setSaving(false)
  }

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  return (
    <div style={{ background: "#032855", color: "white", minHeight: "100vh", padding: "40px", fontFamily: "'Arial', sans-serif" }}>
      <h1 style={{ fontSize: "32px", fontWeight: "700", textTransform: "uppercase", textAlign: "center", marginBottom: "20px", fontFamily: "'Helvetica Neue', sans-serif" }}>
        Admin: Edit Remark
      </h1>

      <div style={{ display: "flex", justifyContent: "center", marginBottom: "20px" }}>
        <textarea
          style={{
            width: "80%",
            minHeight: "120px",
            padding: "12px",
            fontSize: "16px",
            borderRadius: "6px",
            border: "none",
            resize: "vertical",
            fontFamily: "'Arial', sans-serif"
          }}
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
        />
      </div>

      <div style={{ textAlign: "center" }}>
        <button
          onClick={saveRemark}
          disabled={saving}
          style={{
            backgroundColor: "#1fa97a",
            color: "white",
            textTransform: "uppercase",
            fontWeight: "700",
            fontSize: "16px",
            padding: "12px 24px",
            borderRadius: "6px",
            border: "none",
            cursor: "pointer",
            boxShadow: "0 4px 8px rgba(0,0,0,0.3)",
            transition: "all 0.2s ease-in-out"
          }}
          onMouseEnter={(e:any) => e.currentTarget.style.transform = "translateY(-2px)"}
          onMouseLeave={(e:any) => e.currentTarget.style.transform = "translateY(0px)"}
        >
          {saving ? "Saving..." : "Save Remark"}
        </button>
      </div>

      {message && (
        <p style={{ textAlign: "center", marginTop: "16px", fontWeight: "600", color: "#25D366" }}>
          {message}
        </p>
      )}
    </div>
  )
}