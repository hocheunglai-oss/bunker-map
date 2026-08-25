"use client"

import { useCallback, useEffect, useState } from "react"

type BackupMode = {
  eligible: boolean
  enabled: boolean
  expiresAt: string | null
  hoursRemaining?: number
  maskedPhone: string
  conversationOpen?: boolean
  activationStatus?: string
  message?: string
}

export function SpcMobileModeControl() {
  const [mode, setMode] = useState<BackupMode | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/spc/mobile-mode", { cache: "no-store" })
      const payload = (await response.json()) as BackupMode
      if (!response.ok) throw new Error(payload.message || "Backup Mode is unavailable.")
      setMode(payload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Backup Mode is unavailable.")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!mode?.enabled || !mode.expiresAt) return
    const expiresAt = Date.parse(mode.expiresAt)
    const timer = window.setTimeout(() => void load(), Math.max(1_000, expiresAt - Date.now() + 1_000))
    return () => window.clearTimeout(timer)
  }, [load, mode?.enabled, mode?.expiresAt])

  async function toggle() {
    if (!mode?.eligible || mode.enabled || saving) return
    setSaving(true)
    setError("")
    try {
      const response = await fetch("/api/spc/mobile-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !mode.enabled }),
      })
      const payload = (await response.json()) as BackupMode
      if (!response.ok) throw new Error(payload.message || "Backup Mode could not be changed.")
      setMode(payload)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Backup Mode could not be changed.")
    } finally {
      setSaving(false)
    }
  }

  if (!mode?.eligible) return null
  return (
    <div className={`spc-mobile-mode${mode.enabled ? " is-active" : ""}`}>
      <div>
        <strong>BACKUP MODE</strong>
        <span>{mode.enabled ? `${mode.conversationOpen ? "READY" : "CHECK WHATSAPP"} · ${mode.hoursRemaining || 1}H LEFT` : "OFF"}</span>
      </div>
      <button type="button" role="switch" aria-checked={mode.enabled} onClick={toggle} disabled={saving || mode.enabled}>
        <span aria-hidden="true" />
        <span className="sr-only">{mode.enabled ? "Backup Mode remains active for 24 hours" : "Activate Backup Mode"} for {mode.maskedPhone}</span>
      </button>
      {error ? <small role="alert">{error}</small> : null}
    </div>
  )
}
