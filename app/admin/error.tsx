"use client"

import { useEffect } from "react"

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Admin route failed", error)
  }, [error])

  return (
    <div
      style={{
        minHeight: "45vh",
        display: "grid",
        placeItems: "center",
        padding: "32px",
        background: "var(--fc-admin-page-bg)",
        color: "var(--fc-admin-panel-text)",
        fontFamily: "var(--fc-admin-font)",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <p style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: 800 }}>
          This admin tool could not be loaded.
        </p>
        <button
          type="button"
          onClick={reset}
          data-admin-view-safe="true"
          style={{
            minHeight: "36px",
            border: "1px solid var(--fc-admin-button-border)",
            borderRadius: "999px",
            background: "var(--fc-admin-button-bg)",
            color: "var(--fc-admin-button-text)",
            padding: "8px 14px",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    </div>
  )
}
