"use client"

import Link from "next/link"

type DisclaimerLinkProps = {
  centered?: boolean
  subtle?: boolean
}

export default function DisclaimerLink({ centered = false, subtle = false }: DisclaimerLinkProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: centered ? "center" : "flex-start",
      }}
    >
      <Link
        href="/disclaimer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: subtle ? "6px 10px" : "8px 12px",
          borderRadius: "999px",
          border: "1px solid rgba(210,236,255,0.14)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.06) 100%)",
          color: "#cfe7fb",
          textDecoration: "none",
          fontSize: subtle ? "12px" : "13px",
          fontWeight: 700,
          letterSpacing: "0.02em",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
        }}
      >
        <span>For Indication Only</span>
        <span
          aria-hidden="true"
          style={{
            width: "16px",
            height: "16px",
            borderRadius: "999px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "10px",
            fontWeight: 800,
            color: "#e8f4ff",
            background: "linear-gradient(180deg, rgba(72, 170, 255, 0.24) 0%, rgba(20, 112, 196, 0.12) 100%)",
            border: "1px solid rgba(143,215,255,0.22)",
          }}
        >
          i
        </span>
      </Link>
    </div>
  )
}
