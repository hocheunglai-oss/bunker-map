"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { WhatsAppSpeedBoardSetup } from "@/components/WhatsAppSpeedBoardSetup"
import { useSpcAuth } from "@/lib/useSpcAuth"
import { canAccessSpcPage } from "@/lib/spcPages"

export default function SpcSupplierPage() {
  const router = useRouter()
  const { loading, authenticated, permissions } = useSpcAuth()
  const canView = authenticated && canAccessSpcPage(permissions, "spc-whatsapp", "view")

  useEffect(() => {
    document.title = "SPC WhatsApp Speed Board"
  }, [])

  useEffect(() => {
    if (!loading && !canView) router.replace("/spc")
  }, [canView, loading, router])

  if (loading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return <WhatsAppSpeedBoardSetup backHref="/spc" title="SPC WhatsApp Speed Board" />
}
