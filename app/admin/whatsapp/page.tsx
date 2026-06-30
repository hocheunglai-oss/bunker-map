"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { WhatsAppSpeedBoardSetup } from "@/components/WhatsAppSpeedBoardSetup"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

export default function WhatsAppAdminPage() {
  const router = useRouter()
  const { loading, authenticated, permissions, role } = useSimpleAdminAuth()
  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "whatsapp", "view")

  useEffect(() => {
    document.title = "WhatsApp Speed Board - FC Uno"
  }, [])

  useEffect(() => {
    if (!loading && (!authenticated || !canView)) router.replace("/admin")
  }, [authenticated, canView, loading, router])

  if (loading || !authenticated || !canView) {
    return <div style={{ minHeight: "100vh", background: "var(--fc-admin-page-bg)" }} />
  }

  return <WhatsAppSpeedBoardSetup backHref="/admin" title="WhatsApp Speed Board" />
}
