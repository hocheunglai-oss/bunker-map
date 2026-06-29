"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { WhatsAppWorkspace } from "@/components/WhatsAppWorkspace"
import { useSpcAuth } from "@/lib/useSpcAuth"

export default function SpcSupplierPage() {
  const router = useRouter()
  const { loading, authenticated, role } = useSpcAuth()
  const isSupplier = authenticated && role === "supplier_trader"

  useEffect(() => {
    document.title = "SPC WhatsApp"
  }, [])

  useEffect(() => {
    if (!loading && !isSupplier) router.replace("/spc")
  }, [isSupplier, loading, router])

  return (
    <WhatsAppWorkspace
      auth={{
        loading,
        authenticated: isSupplier,
        canView: isSupplier,
        canEdit: isSupplier,
      }}
      apiBasePath="/api/spc/whatsapp"
      backHref="/spc"
      backLabel="Return to SPC"
    />
  )
}
