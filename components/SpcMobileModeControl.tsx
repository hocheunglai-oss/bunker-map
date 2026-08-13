"use client"

import { useCallback, useEffect, useState } from "react"

type MobileMode = {
  eligible: boolean
  enabled: boolean
  expiresAt: string | null
  maskedPhone: string
  conversationOpen?: boolean
  activationStatus?: string
  message?: string
}

export function SpcMobileModeControl() {
  const [mode, setMode] = useState<MobileMode | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/spc/mobile-mode", { cache: "no-store" })
      const payload = (await response.json()) as MobileMode
      if (!response.ok) throw new Error(payload.message || "Mobile Mode is unavailable.")
      setMode(payload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Mobile Mode is unavailable.")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function toggle() {
    if (!mode?.eligible || saving) return
    setSaving(true)
    setError("")
    try {
      const response = await fetch("/api/spc/mobile-mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !mode.enabled }),
      })
      const payload = (await response.json()) as MobileMode
      if (!response.ok) throw new Error(payload.message || "Mobile Mode could not be changed.")
      setMode(payload)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Mobile Mode could not be changed.")
    } finally {
      setSaving(false)
    }
  }

  if (!mode?.eligible) return null
  return (
    <div className={`spc-mobile-mode${mode.enabled ? " is-active" : ""}`}>
      <div>
        <strong>MOBILE MODE</strong>
        <span>{mode.enabled ? (mode.conversationOpen ? "ON · READY" : "ON · CHECK WHATSAPP") : "OFF"}</span>
      </div>
      <button type="button" role="switch" aria-checked={mode.enabled} onClick={toggle} disabled={saving}>
        <span aria-hidden="true" />
        <span className="sr-only">{mode.enabled ? "Deactivate" : "Activate"} Mobile Mode for {mode.maskedPhone}</span>
      </button>
      {error ? <small role="alert">{error}</small> : null}
    </div>
  )
}
