"use client"

import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { clearSpcClientSessionCache, useSpcAuth } from "@/lib/useSpcAuth"

type SpcShellProps = {
  title: string
  children: React.ReactNode
}

export function SpcShell({ title, children }: SpcShellProps) {
  const router = useRouter()
  const { displayName, role } = useSpcAuth()

  async function logout() {
    await fetch("/api/spc/logout", { method: "POST" })
    clearSpcClientSessionCache()
    router.push("/spc")
    router.refresh()
  }

  return (
    <div className="spc-app-page">
      <header className="spc-topbar">
        <Link href="/spc" className="spc-topbar-brand" aria-label="Singapore Purchasing Center">
          <Image src="/fc-uno-sidebar-logo.png" alt="Fratelli Cosulich UNO" width={202} height={40} priority />
          <span>
            <strong>Singapore</strong>
            <small>Purchasing Center</small>
          </span>
        </Link>

        <nav className="spc-topbar-nav" aria-label="SPC navigation">
          {role === "buyer_trader" ? (
            <>
              <Link href="/spc/buyer">Enquiries</Link>
              <Link href="/spc/usermanagement">User Management</Link>
            </>
          ) : null}
          {role === "supplier_trader" ? <Link href="/spc/supplier">WhatsApp</Link> : null}
        </nav>

        <div className="spc-topbar-user">
          <span>{displayName || "SPC"}</span>
          <button type="button" onClick={() => void logout()}>
            Logout
          </button>
        </div>
      </header>

      <main className="spc-main" aria-label={title}>
        {children}
      </main>
    </div>
  )
}
