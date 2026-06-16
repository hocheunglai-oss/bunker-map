"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { getAdminPageByPathFromPages } from "@/lib/adminPageRegistry"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
}

const panelStyle: React.CSSProperties = {
  width: "min(420px, 100%)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px #00000010",
  padding: "24px",
  textAlign: "center",
}

const buttonStyle: React.CSSProperties = {
  minHeight: "36px",
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 800,
  padding: "8px 14px",
  boxShadow: "none",
}

const MUTATION_ACTION_PATTERN =
  /(^|\s|\+)(add(?:ed|ing)?|appl(?:y|ied|ying)|archiv(?:e|ed|ing)|creat(?:e|ed|ing)|delet(?:e|ed|ing)|edit(?:ed|ing)?|import(?:ed|ing)?|insert(?:ed|ing)?|mov(?:e|ed|ing)|new|publish(?:ed|ing)?|rebuild(?:ing)?|rebuilt|remov(?:e|ed|ing)|renam(?:e|ed|ing)|restor(?:e|ed|ing)|retr(?:y|ied|ying)|sav(?:e|ed|ing)|send|sending|sent|submit(?:ted|ting)?|sync(?:ed|ing)?|undo|updat(?:e|ed|ing)|upload(?:ed|ing)?)(\s|$)|row above|row below|col left|col right|clear special|paste table/i

function getControlLabel(element: HTMLElement) {
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.textContent,
    element instanceof HTMLInputElement ? element.value : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

function isSearchControl(element: HTMLInputElement | HTMLTextAreaElement) {
  const label = [
    element.type,
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("name"),
  ]
    .filter(Boolean)
    .join(" ")

  return /\b(search|filter|find|query)\b/i.test(label)
}

function setViewOnlyControls(root: ParentNode, viewOnly: boolean) {
  root.querySelectorAll<HTMLElement>("button, input, textarea, select, [contenteditable]")
    .forEach((element) => {
      if (!viewOnly) {
        if (element.dataset.adminViewOnlyDisabled === "true") {
          if (
            element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
          ) {
            element.disabled = element.dataset.adminOriginallyDisabled === "true"
          }
          delete element.dataset.adminViewOnlyDisabled
          delete element.dataset.adminOriginallyDisabled
          element.removeAttribute("aria-disabled")
        }

        if (element.dataset.adminViewOnlyReadonly === "true") {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.readOnly = element.dataset.adminOriginallyReadonly === "true"
          }
          delete element.dataset.adminViewOnlyReadonly
          delete element.dataset.adminOriginallyReadonly
        }
        return
      }

      if (element.closest("[data-admin-view-safe='true']")) return
      if (element.classList.contains("fc-admin-nav-button")) return

      if (element instanceof HTMLButtonElement) {
        const label = getControlLabel(element)
        if (
          !MUTATION_ACTION_PATTERN.test(label) &&
          !["+", "x", "X", "×", "✕", "↑", "↓"].includes(label)
        ) {
          return
        }
        if (element.dataset.adminViewOnlyDisabled === "true") return

        element.dataset.adminOriginallyDisabled = String(element.disabled)
        element.dataset.adminViewOnlyDisabled = "true"
        element.disabled = true
        element.setAttribute("aria-disabled", "true")
        element.title = "View-only access"
        return
      }

      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (isSearchControl(element)) return

        if (["checkbox", "radio", "file", "range", "color"].includes(element.type)) {
          if (element.dataset.adminViewOnlyDisabled === "true") return
          element.dataset.adminOriginallyDisabled = String(element.disabled)
          element.dataset.adminViewOnlyDisabled = "true"
          element.disabled = true
          element.setAttribute("aria-disabled", "true")
        } else {
          if (element.dataset.adminViewOnlyReadonly === "true") return
          element.dataset.adminOriginallyReadonly = String(element.readOnly)
          element.dataset.adminViewOnlyReadonly = "true"
          element.readOnly = true
        }
        return
      }

      if (element instanceof HTMLSelectElement) {
        if (element.dataset.adminViewOnlyDisabled === "true") return
        element.dataset.adminOriginallyDisabled = String(element.disabled)
        element.dataset.adminViewOnlyDisabled = "true"
        element.disabled = true
        element.setAttribute("aria-disabled", "true")
        return
      }

      if (element.isContentEditable) {
        element.contentEditable = "false"
      }
    })
}

export function AdminRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { loading, authenticated, permissions, role, pages } = useSimpleAdminAuth()
  const page = getAdminPageByPathFromPages(pathname, pages)
  const [guardedRequestKey, setGuardedRequestKey] = useState("")
  const requestGuardKey =
    page && authenticated && !isAdminRole(role)
      ? `${page.id}:${permissions[page.id] || "none"}`
      : ""
  const viewOnly =
    Boolean(page && authenticated && !isAdminRole(role)) &&
    !canAccessAdminPage(permissions, page?.id || "", "edit")

  useEffect(() => {
    if (loading || !authenticated || !page || isAdminRole(role)) return

    const originalFetch = window.fetch.bind(window)
    const canEdit = canAccessAdminPage(permissions, page.id, "edit")

    const guardedFetch: typeof window.fetch = (input, init) => {
      const method =
        init?.method?.toUpperCase() ||
        (input instanceof Request ? input.method.toUpperCase() : "GET")

      if (!canEdit && !["GET", "HEAD", "OPTIONS"].includes(method)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              message: "You have view-only access to this admin page.",
            }),
            {
              status: 403,
              headers: {
                "Content-Type": "application/json",
              },
            }
          )
        )
      }

      return originalFetch(input, init)
    }
    window.fetch = guardedFetch
    setGuardedRequestKey(requestGuardKey)

    return () => {
      if (window.fetch === guardedFetch) {
        window.fetch = originalFetch
      }
    }
  }, [authenticated, loading, page, permissions, requestGuardKey, role])

  useEffect(() => {
    if (!page || loading) return

    const root = document.querySelector(".fc-admin-scope")
    if (!root) return

    const apply = () => setViewOnlyControls(root, viewOnly)
    apply()

    const observer = new MutationObserver(apply)
    observer.observe(root, { childList: true, subtree: true })

    const blockSubmit = (event: Event) => {
      if (!viewOnly) return
      event.preventDefault()
      event.stopPropagation()
    }
    root.addEventListener("submit", blockSubmit, true)

    return () => {
      observer.disconnect()
      root.removeEventListener("submit", blockSubmit, true)
      setViewOnlyControls(root, false)
    }
  }, [loading, page, viewOnly])

  if (!page || pathname === "/admin") return <>{children}</>

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (requestGuardKey && guardedRequestKey !== requestGuardKey) {
    return <p style={{ padding: "40px" }}>Loading...</p>
  }

  const hasAccess =
    authenticated && (isAdminRole(role) || canAccessAdminPage(permissions, page.id, "view"))

  if (!hasAccess) {
    return (
      <div style={pageStyle}>
        <div style={panelStyle}>
          <h1 style={{ margin: "0 0 8px", fontSize: "20px" }}>Access Denied</h1>
          <p style={{ margin: "0 0 18px", color: "var(--fc-admin-muted)", fontSize: "13px" }}>
            Your account does not have access to this admin page.
          </p>
          <button type="button" onClick={() => router.push("/admin")} className="fc-admin-nav-button" style={buttonStyle}>
            Go To Admin
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {viewOnly ? (
        <div
          role="status"
          style={{
            borderBottom: "1px solid var(--fc-admin-border)",
            background: "var(--fc-admin-warning-bg)",
            color: "var(--fc-admin-warning-text)",
            padding: "8px 14px",
            fontSize: "12px",
            fontWeight: 800,
            textAlign: "center",
          }}
        >
          View-only access. Changes, uploads, syncs, and record actions are disabled.
        </div>
      ) : null}
      {children}
    </>
  )
}
