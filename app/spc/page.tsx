"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { primeSpcClientSessionCache, useSpcAuth } from "@/lib/useSpcAuth"
import { SpcShell } from "@/components/SpcShell"
import { getSpcSessionPresentationLabel } from "@/lib/spcSessionPresentation"
import type { SpcPageDefinition, SpcPagePermissionMap, SpcRoleId } from "@/lib/spcPages"

const LOGIN_UNAVAILABLE_MESSAGE = "Sign-in is temporarily unavailable. Please try again."
const LOGIN_RATE_LIMIT_MESSAGE = "Too many sign-in attempts. Please try again later."
const MFA_VERIFICATION_MESSAGE = "The code could not be verified. Use your password to request a new code."

type SpcLoginResponse = {
  message?: string
  mfaRequired?: boolean
  expiresAt?: string
  phoneHint?: string
  user?: {
    username?: string
    displayName?: string
    role?: SpcRoleId
    office?: string
    mustChangePassword?: boolean
    permissions?: SpcPagePermissionMap
  }
  pages?: SpcPageDefinition[]
}

type SpcMfaChallenge = {
  expiresAt: string
  phoneHint: string
}

function secondsUntil(expiry: string) {
  const expiresAt = Date.parse(expiry)
  if (!Number.isFinite(expiresAt)) return 0
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

function safePhoneHint(value: string | undefined) {
  const hint = String(value || "").trim()
  return /^\+[0-9]{1,3}•+[0-9]{4}$/.test(hint)
    ? hint
    : "your registered WhatsApp number"
}

export default function SpcLoginPage() {
  const router = useRouter()
  const {
    loading,
    authenticated,
    displayName,
    username: sessionUsername,
    role,
  } = useSpcAuth()
  const [loginUsername, setLoginUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")
  const [mfaChallenge, setMfaChallenge] = useState<SpcMfaChallenge | null>(null)
  const [mfaCode, setMfaCode] = useState("")
  const [mfaSecondsRemaining, setMfaSecondsRemaining] = useState(0)
  const usernameInputRef = useRef<HTMLInputElement>(null)
  const mfaCodeInputRef = useRef<HTMLInputElement>(null)
  const usePasswordButtonRef = useRef<HTMLButtonElement>(null)
  const focusUsernameAfterCancel = useRef(false)
  const sessionPresentationLabel = getSpcSessionPresentationLabel({
    role,
    displayName,
    username: sessionUsername,
  })

  useEffect(() => {
    document.title = "Singapore Purchasing Center"
  }, [])

  useEffect(() => {
    if (!mfaChallenge) return

    function updateCountdown() {
      setMfaSecondsRemaining(secondsUntil(mfaChallenge?.expiresAt || ""))
    }

    updateCountdown()
    const interval = window.setInterval(updateCountdown, 1000)
    return () => window.clearInterval(interval)
  }, [mfaChallenge])

  useEffect(() => {
    if (mfaChallenge) {
      mfaCodeInputRef.current?.focus()
      return
    }

    if (focusUsernameAfterCancel.current) {
      focusUsernameAfterCancel.current = false
      usernameInputRef.current?.focus()
    }
  }, [mfaChallenge])

  useEffect(() => {
    if (mfaChallenge && mfaSecondsRemaining === 0) {
      usePasswordButtonRef.current?.focus()
    }
  }, [mfaChallenge, mfaSecondsRemaining])

  function completeLogin(data: SpcLoginResponse) {
    primeSpcClientSessionCache({
      authenticated: true,
      username: data.user?.username || null,
      displayName: data.user?.displayName || data.user?.username || null,
      role: data.user?.role || null,
      office: data.user?.office || null,
      mustChangePassword: data.user?.mustChangePassword === true,
      permissions: data.user?.permissions || {},
      pages: data.pages || [],
    })

    router.replace("/spc")
    router.refresh()
  }

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: loginUsername, password }),
      })

      const data = (await response.json().catch(() => ({}))) as SpcLoginResponse
      if (response.status === 202 && data.mfaRequired === true) {
        const remaining = secondsUntil(data.expiresAt || "")
        if (!data.expiresAt || remaining === 0) {
          setMessage(LOGIN_UNAVAILABLE_MESSAGE)
          return
        }

        setPassword("")
        setShowPassword(false)
        setMfaCode("")
        setMfaSecondsRemaining(remaining)
        setMfaChallenge({
          expiresAt: data.expiresAt,
          phoneHint: safePhoneHint(data.phoneHint),
        })
        return
      }

      if (!response.ok || response.status !== 200) {
        setMessage(
          response.status === 401
            ? "Invalid username or password."
            : response.status === 429
              ? data.message || LOGIN_RATE_LIMIT_MESSAGE
              : LOGIN_UNAVAILABLE_MESSAGE,
        )
        return
      }

      completeLogin(data)
    } catch {
      setMessage(LOGIN_UNAVAILABLE_MESSAGE)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleMfaVerification(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage("")

    if (!mfaChallenge || mfaSecondsRemaining === 0 || !/^\d{6}$/.test(mfaCode)) {
      setMessage(MFA_VERIFICATION_MESSAGE)
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch("/api/spc/login/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: mfaCode }),
      })
      const data = (await response.json().catch(() => ({}))) as SpcLoginResponse

      if (!response.ok || response.status !== 200) {
        setMfaCode("")
        if (response.status === 400) {
          window.requestAnimationFrame(() => mfaCodeInputRef.current?.focus())
        } else {
          setMfaSecondsRemaining(0)
        }
        setMessage(response.status >= 500 ? LOGIN_UNAVAILABLE_MESSAGE : MFA_VERIFICATION_MESSAGE)
        return
      }

      completeLogin(data)
    } catch {
      setMessage(LOGIN_UNAVAILABLE_MESSAGE)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUsePasswordAgain() {
    setSubmitting(true)
    setMessage("")
    let cancelFailed = false

    try {
      const response = await fetch("/api/spc/login/mfa/cancel", { method: "POST" })
      cancelFailed = !response.ok
    } catch {
      cancelFailed = true
    } finally {
      focusUsernameAfterCancel.current = true
      setMfaChallenge(null)
      setMfaCode("")
      setPassword("")
      setShowPassword(false)
      setMfaSecondsRemaining(0)
      setSubmitting(false)
      setMessage(cancelFailed ? LOGIN_UNAVAILABLE_MESSAGE : "")
    }
  }

  if (!loading && authenticated) {
    return (
      <SpcShell title="SPC Welcome">
        <section className="fc-admin-welcome-page spc-welcome-page" aria-label="SPC welcome">
          <div className="fc-admin-welcome-content spc-welcome-content">
            <h1>WELCOME{sessionPresentationLabel ? `, ${sessionPresentationLabel}` : ""}</h1>
            <p className="spc-welcome-introduction">
              YOU ARE INVITED TO THE PRESENTATION OF
              <br />
              <Link href="/spc/presentation">INCORPORATE AI INTO TRADING</Link>
            </p>
            <p className="spc-welcome-enquiry">
              OR <Link href="/spc/enquiries">SEND ENQUIRY NOW</Link>
            </p>
          </div>
        </section>
      </SpcShell>
    )
  }

  return (
    <div className="spc-login-page">
      <section
        className={`spc-login-card${mfaChallenge ? " is-mfa" : ""}`}
        aria-label="Singapore Purchasing Center login"
      >
        <h1 className="sr-only">Singapore Purchasing Center</h1>

        {mfaChallenge ? (
          <form onSubmit={handleMfaVerification} className="spc-login-form spc-login-mfa-form">
            <div className="spc-login-mfa-copy">
              <h2>Verify WhatsApp code</h2>
              <p id="spc-mfa-destination">
                Enter the six-digit code sent to <strong>{mfaChallenge.phoneHint}</strong>.
              </p>
            </div>

            <label className="spc-login-field spc-login-mfa-field">
              <span className="spc-login-hidden-label">Six-digit WhatsApp code</span>
              <input
                ref={mfaCodeInputRef}
                name="mfa-code"
                type="text"
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                aria-label="Six-digit WhatsApp code"
                aria-describedby="spc-mfa-destination spc-mfa-expiry"
                disabled={submitting || mfaSecondsRemaining === 0}
                autoFocus
                required
              />
            </label>

            <p id="spc-mfa-expiry" className="spc-login-mfa-timer" role="timer" aria-live="off">
              {mfaSecondsRemaining > 0
                ? `Code expires in ${formatCountdown(mfaSecondsRemaining)}`
                : "Code expired"}
            </p>
            <span className="sr-only" aria-live="polite">
              {mfaSecondsRemaining === 0 ? "The WhatsApp code has expired. Use your password again." : ""}
            </span>

            <button
              type="submit"
              disabled={submitting || mfaSecondsRemaining === 0 || mfaCode.length !== 6}
              className="spc-login-submit"
            >
              {submitting ? "Verifying" : "Verify Code"}
            </button>

            <button
              ref={usePasswordButtonRef}
              type="button"
              className="spc-login-use-password"
              onClick={handleUsePasswordAgain}
              disabled={submitting}
            >
              Use password again
            </button>

            <p className="spc-login-mfa-help">New codes can be requested with your password after 60 seconds.</p>

            {message ? <p className="spc-login-message" role="alert">{message}</p> : null}
          </form>
        ) : (
          <form onSubmit={handleLogin} className="spc-login-form">
            <label className="spc-login-field">
              <span className="spc-login-hidden-label">Username</span>
              <span className="spc-input-wrap">
                <span className="spc-field-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
                    <path d="M4.5 21c.9-4.6 3.4-7 7.5-7s6.6 2.4 7.5 7" />
                  </svg>
                </span>
                <input
                  ref={usernameInputRef}
                  name="username"
                  value={loginUsername}
                  onChange={(event) => setLoginUsername(event.target.value)}
                  autoComplete="username"
                  aria-label="Username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={320}
                  required
                />
              </span>
            </label>

            <label className="spc-login-field">
              <span className="spc-login-hidden-label">Password</span>
              <span className="spc-password-wrap">
                <span className="spc-field-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="M7 10V8a5 5 0 0 1 10 0v2" />
                    <path d="M6 10h12v10H6V10Z" />
                    <path d="M12 14.2v2.6" />
                  </svg>
                </span>
                <input
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  aria-label="Password"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={256}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" />
                    <circle cx="12" cy="12" r="2.6" />
                  </svg>
                </button>
              </span>
            </label>

            <button type="submit" disabled={submitting || loading} className="spc-login-submit">
              {submitting ? "Signing In" : "Log In"}
            </button>

            {message ? <p className="spc-login-message" role="alert">{message}</p> : null}
          </form>
        )}
      </section>
    </div>
  )
}
