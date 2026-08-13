"use client"

import { useState } from "react"
import { SpcShell } from "@/components/SpcShell"

export default function SpcMobileSetupPage() {
  const [status, setStatus] = useState("")
  const [saving, setSaving] = useState(false)
  async function runSetup() {
    setSaving(true)
    const response = await fetch("/api/spc/mobile-mode/setup", { method: "POST" })
    const payload = (await response.json().catch(() => ({}))) as { success?: boolean; templateStatus?: string; message?: string }
    setStatus(response.ok && payload.success ? `READY: ${payload.templateStatus || "PENDING"}` : payload.message || "SETUP FAILED")
    setSaving(false)
  }
  return (
    <SpcShell title="SPC Mobile Mode Setup">
      <section className="spc-panel" style={{ maxWidth: 520, margin: "40px auto" }}>
        <div className="spc-panel-header"><h2>Mobile Mode Setup</h2></div>
        <div style={{ padding: 20 }}>
          <button type="button" className="spc-blue-action" onClick={runSetup} disabled={saving}>{saving ? "SETTING UP..." : "RUN SECURE SETUP"}</button>
          {status ? <p role="status">{status}</p> : null}
        </div>
      </section>
    </SpcShell>
  )
}
