"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { WhatsAppWorkspace } from "@/components/WhatsAppWorkspace"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"

export default function SpcSupplierPage() {
  const router = useRouter()
  const { loading, authenticated, permissions } = useSpcAuth()
  const canView = authenticated && canAccessSpcPage(permissions, "spc-whatsapp", "view")
  const canEdit = authenticated && canAccessSpcPage(permissions, "spc-whatsapp", "edit")

  useEffect(() => {
    document.title = "SPC WhatsApp"
  }, [])

  useEffect(() => {
    if (!loading && !canView) router.replace("/spc")
  }, [canView, loading, router])

  return (
    <WhatsAppWorkspace
      auth={{
        loading,
        authenticated: canView,
        canView,
        canEdit,
      }}
      apiBasePath="/api/spc/whatsapp"
      backHref="/spc"
      backLabel="Return to SPC"
    />
  )
}
