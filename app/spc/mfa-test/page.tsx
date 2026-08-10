"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import {
  SPC_MFA_TEST_MAX_ATTEMPTS,
  SPC_MFA_TEST_RESEND_SECONDS,
} from "@/lib/spcMfaTestConstants"
import { useSpcAuth } from "@/lib/useSpcAuth"

type ActiveChallenge = {
  challengeId: string
  targetUserId: string
  expiresAt: string
  attemptsRemaining: number
}

type MfaTestTarget = {
  id: string
  username: string
  displayName: string
  phoneHint: string
  ready: boolean
}

type MfaTestStatus = {
  configured: boolean
  targets: MfaTestTarget[]
  activeChallenge: ActiveChallenge | null
  scope: string
  message?: string
}

type MfaTestActionResponse = {
  success?: boolean
  result?: string
  challengeId?: string
  expiresAt?: string | null
  attemptsRemaining?: number
  retryAfterSeconds?: number
  phoneHint?: string
  message?: string
  warning?: string
}

function secondsUntil(value: string | null, now: number) {
  if (!value) return 0
  return Math.max(0, Math.ceil((Date.parse(value) - now) / 1000))
}

function compactDuration(seconds: number) {
  if (seconds >= 60 * 60) return `${Math.ceil(seconds / (60 * 60))}h`
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`
  return `${seconds}s`
}

export default function SpcMfaTestPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const [status, setStatus] = useState<MfaTestStatus | null>(null)
  const [challenge, setChallenge] = useState<ActiveChallenge | null>(null)
  const [selectedTargetId, setSelectedTargetId] = useState("")
  const [code, setCode] = useState("")
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState<string | null>(null)
  const [now, setNow] = useState(0)
  const canEdit = canAccessSpcPage(permissions, "spc-mfa-test", "edit")
  const hasPermissionSnapshot = Object.prototype.hasOwnProperty.call(
    permissions,
    "spc-mfa-test",
  )

  useEffect(() => {
    document.title = "SPC MFA Test"
  }, [])

  useEffect(() => {
    if (!authLoading && !authenticated) router.replace("/spc")
    if (!authLoading && authenticated && hasPermissionSnapshot && !canEdit) {
      router.replace("/spc")
    }
  }, [authLoading, authenticated, canEdit, hasPermissionSnapshot, router])

  useEffect(() => {
    if (!authenticated || !canEdit) return
    const controller = new AbortController()
    void fetch("/api/spc/mfa-test", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = (await response.json()) as MfaTestStatus
        if (!response.ok) throw new Error(data.message || "Failed to load the MFA test.")
        return data
      })
      .then((data) => {
        setStatus(data)
        setChallenge(data.activeChallenge)
        setNow(Date.now())
        setSelectedTargetId(
          data.activeChallenge?.targetUserId ||
          data.targets.find((target) => target.ready)?.id ||
          data.targets[0]?.id ||
          "",
        )
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return
        setMessage(error instanceof Error ? error.message : "Failed to load the MFA test.")
        setMessageIsError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [authenticated, canEdit])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const expiresIn = secondsUntil(challenge?.expiresAt || null, now)
  const cooldownRemaining = secondsUntil(cooldownUntil, now)
  const selectedTarget = status?.targets.find((target) => target.id === selectedTargetId) || null
  const ready = Boolean(status?.configured && selectedTarget?.ready)
  const verificationDisabled =
    verifying ||
    !challenge ||
    expiresIn <= 0 ||
    !/^[0-9]{6}$/.test(code)
  const attemptsLabel = useMemo(() => {
    if (!challenge) return String(SPC_MFA_TEST_MAX_ATTEMPTS)
    return String(challenge.attemptsRemaining)
  }, [challenge])

  async function sendCode() {
    if (!ready || cooldownRemaining > 0) return
    setSending(true)
    setMessage("")
    setMessageIsError(false)
    try {
      const response = await fetch("/api/spc/mfa-test/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: selectedTargetId }),
      })
      const data = (await response.json()) as MfaTestActionResponse
      if (!response.ok || !data.challengeId || !data.expiresAt) {
        if (data.retryAfterSeconds) {
          setCooldownUntil(
            new Date(Date.now() + data.retryAfterSeconds * 1000).toISOString(),
          )
        }
        throw new Error(data.message || "Failed to send the test code.")
      }

      setChallenge({
        challengeId: data.challengeId,
        targetUserId: selectedTargetId,
        expiresAt: data.expiresAt,
        attemptsRemaining: data.attemptsRemaining ?? SPC_MFA_TEST_MAX_ATTEMPTS,
      })
      setCooldownUntil(
        new Date(Date.now() + SPC_MFA_TEST_RESEND_SECONDS * 1000).toISOString(),
      )
      setCode("")
      setMessage(`${data.message || "Test code sent."}${data.warning ? ` ${data.warning}` : ""}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to send the test code.")
      setMessageIsError(true)
    } finally {
      setSending(false)
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!challenge || verificationDisabled) return
    setVerifying(true)
    setMessage("")
    setMessageIsError(false)
    try {
      const response = await fetch("/api/spc/mfa-test/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          targetUserId: challenge.targetUserId,
          code,
        }),
      })
      const data = (await response.json()) as MfaTestActionResponse
      const feedback = `${data.message || "Verification failed."}${data.warning ? ` ${data.warning}` : ""}`
      setMessage(feedback)

      if (!response.ok || !data.success) {
        setMessageIsError(true)
        setChallenge((current) => current
          ? {
              ...current,
              attemptsRemaining: data.attemptsRemaining ?? current.attemptsRemaining,
            }
          : current)
        if (data.result !== "mismatch") setChallenge(null)
        setCode("")
        return
      }

      setChallenge(null)
      setCode("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to verify the test code.")
      setMessageIsError(true)
    } finally {
      setVerifying(false)
    }
  }

  if (authLoading || !authenticated || !hasPermissionSnapshot || !canEdit) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC MFA Test">
      {message ? (
        <div
          className={`spc-alert${messageIsError ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {message}
        </div>
      ) : null}

      <section className="spc-panel">
        <div className="spc-panel-header">
          <h2>WhatsApp MFA Test</h2>
          <span className="spc-mfa-test-badge">ADMIN-ONLY TEST</span>
        </div>
        <div className="spc-health-grid">
          <div>
            <span>RECIPIENT</span>
            <strong>{selectedTarget?.displayName || "-"}</strong>
          </div>
          <div>
            <span>WHATSAPP</span>
            <strong>{selectedTarget?.phoneHint || "NOT SET"}</strong>
          </div>
          <div>
            <span>CODE VALIDITY</span>
            <strong>{challenge ? `${expiresIn}s` : "5 MINUTES"}</strong>
          </div>
          <div>
            <span>ATTEMPTS LEFT</span>
            <strong>{attemptsLabel}</strong>
          </div>
        </div>
      </section>

      <section className="spc-panel spc-mfa-test-panel">
        <div className="spc-panel-header">
          <h2>Test Workflow</h2>
        </div>
        <p className="spc-mfa-test-scope">
          This page tests code delivery and verification for the dedicated inactive MFA_TEST account only. It does not enable MFA or change the current SPC login session.
        </p>

        <div className="spc-mfa-test-account-field">
          <label htmlFor="spc-mfa-test-account">Inactive test account</label>
          <select
            id="spc-mfa-test-account"
            value={selectedTargetId}
            onChange={(event) => setSelectedTargetId(event.target.value)}
            disabled={Boolean(challenge && expiresIn > 0) || sending || verifying}
          >
            {status?.targets.length ? null : <option value="">No inactive test account</option>}
            {status?.targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.displayName} ({target.username}){target.ready ? "" : " - WHATSAPP NOT SET"}
              </option>
            ))}
          </select>
        </div>

        {status && !status.configured ? (
          <div className="spc-alert is-error">The server-side WhatsApp MFA test configuration is incomplete.</div>
        ) : null}
        {status?.configured && !status.targets.length ? (
          <div className="spc-alert is-error">
            Create the inactive MFA_TEST account in <Link href="/spc/usermanagement">USER MANAGEMENT</Link>.
          </div>
        ) : null}
        {status?.configured && selectedTarget && !selectedTarget.ready ? (
          <div className="spc-alert is-error">
            Add the test recipient&apos;s international-format WhatsApp number to {selectedTarget.username} in <Link href="/spc/usermanagement">USER MANAGEMENT</Link>. Keep the account inactive.
          </div>
        ) : null}

        <div className="spc-mfa-test-actions">
          <button
            type="button"
            className="spc-page-action spc-blue-action"
            onClick={() => void sendCode()}
            disabled={!ready || sending || loading || cooldownRemaining > 0}
          >
            {sending
              ? "Sending..."
              : cooldownRemaining > 0
                ? `Resend in ${compactDuration(cooldownRemaining)}`
                : challenge
                  ? "Send New Code"
                  : "Send Test Code"}
          </button>
        </div>

        <form className="spc-mfa-test-form" onSubmit={verifyCode}>
          <label htmlFor="spc-mfa-test-code">Six-digit code</label>
          <div>
            <input
              id="spc-mfa-test-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              disabled={!challenge || expiresIn <= 0 || verifying}
              required
            />
            <button type="submit" disabled={verificationDisabled}>
              {verifying ? "Verifying..." : "Verify Code"}
            </button>
          </div>
        </form>
      </section>
    </SpcShell>
  )
}
