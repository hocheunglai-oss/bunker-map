"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/passwordPolicy"
import { primeSpcClientSessionCache, useSpcAuth } from "@/lib/useSpcAuth"
import type { SpcPagePermissionMap, SpcRoleId } from "@/lib/spcPages"

type PasswordChangeResponse = {
  user?: {
    actorKey?: string
    username?: string
    displayName?: string
    role?: SpcRoleId
    office?: string
    mustChangePassword?: boolean
    permissions?: SpcPagePermissionMap
  }
  message?: string
}

export function SpcForcedPasswordChange() {
  const router = useRouter()
  const {
    actorKey,
    username,
    displayName,
    role,
    office,
    permissions,
    pages,
  } = useSpcAuth()
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])

  async function handlePasswordChange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeRef.current) return
    setMessage("")

    if (newPassword !== confirmPassword) {
      setMessage("Passwords do not match.")
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch("/api/spc/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      })
      const data = (await response.json().catch(() => ({}))) as PasswordChangeResponse
      // A dispatched server change cannot be recalled. Its late response must
      // not publish an old account into a replacement provider or navigate it.
      if (!activeRef.current) return
      if (!response.ok || !data.user) {
        throw new Error(data.message || "Failed to update password.")
      }

      primeSpcClientSessionCache({
        authenticated: true,
        actorKey: data.user.actorKey || actorKey,
        username: data.user.username || username,
        displayName: data.user.displayName || displayName || username,
        role: data.user.role || role,
        office: data.user.office || office,
        mustChangePassword: false,
        permissions: data.user.permissions || permissions,
        pages,
      })
      router.replace("/spc")
      router.refresh()
    } catch (error) {
      if (!activeRef.current) return
      setMessage(error instanceof Error ? error.message : "Failed to update password.")
    } finally {
      if (activeRef.current) setSubmitting(false)
    }
  }

  return (
    <SpcShell title="SPC Password Change">
      <section className="spc-password-change-page" aria-label="Change SPC password">
        <form onSubmit={handlePasswordChange} className="spc-password-change-panel">
          <h1>Change Password</h1>
          <label>
            <span>New Password</span>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              autoFocus
              required
            />
          </label>
          <label>
            <span>Confirm Password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              required
            />
          </label>
          {message ? <p className="spc-login-message" role="alert">{message}</p> : null}
          <button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Save Password"}
          </button>
        </form>
      </section>
    </SpcShell>
  )
}
