"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

export default function AdminRemarks() {
  const [remark, setRemark] = useState<string>("")
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)
  const [message, setMessage] = useState<string>("")
  const [accessDenied, setAccessDenied] = useState<boolean>(false)

  useEffect(() => {
    const checkAdmin = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return setAccessDenied(true)

      const { data: admins } = await supabase
        .from("admins")
        .select("email")
        .eq("email", user.email)
        .limit(1)
        .single()
      if (!admins) return setAccessDenied(true)

      // Load remark
      const { data: remarkData } = await supabase
        .from("remarks")
        .select("*")
        .limit(1)
        .single()
      if (remarkData) setRemark(remarkData.content)
      setLoading(false)
    }

    checkAdmin()
  }, [])

  const saveRemark = async () => {
    setSaving(true)
    setMessage("")
    const { error } = await supabase
      .from("remarks")
      .upsert({ id: 1, content: remark })
    if (error) setMessage("Error saving remark")
    else setMessage("Remark saved successfully!")
    setSaving(false)
  }

  if (accessDenied) return <p style={{ padding: "40px" }}>Access Denied</p>
  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  return (
    <div style={{ background: "#032855", color: "white", minHeight: "100vh", padding: "40px", fontFamily: "'Arial', sans-serif" }}>
      <h1 style={{ fontSize: "32px", fontWeight: "700", textTransform: "uppercase", textAlign: "center", marginBottom: "20px", fontFamily: "'Helvetica Neue', sans-serif" }}>
        Admin: Edit Remark
      </h1>

      <div style={{ display: "flex", justifyContent: "center", marginBottom: "20px" }}>
        <textarea
          style={{ width: "80%", minHeight: "120px", padding: "12px", fontSize: "16px", borderRadius: "6px", border: "none", resize: "vertical", fontFamily: "'Arial', sans-serif" }}
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
        />
      </div>

      <div style={{ textAlign: "center" }}>
        <button
          onClick={saveRemark}
          disabled={saving}
          style={{ backgroundColor: "#1fa97a", color: "white", textTransform: "uppercase", fontWeight: "700", fontSize: "16px", padding: "12px 24px", borderRadius: "6px", border: "none", cursor: "pointer", boxShadow: "0 4px 8px rgba(0,0,0,0.3)" }}
        >
          {saving ? "Saving..." : "Save Remark"}
        </button>
      </div>

      {message && <p style={{ textAlign: "center", marginTop: "16px", fontWeight: "600", color: "#25D366" }}>{message}</p>}
    </div>
  )
}