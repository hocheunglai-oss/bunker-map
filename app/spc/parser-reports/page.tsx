"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { ParserReportReviewPanel } from "@/components/ParserReportReviewPanel"
import { SpcShell } from "@/components/SpcShell"
import { canAccessSpcPage } from "@/lib/spcPages"
import { useSpcAuth } from "@/lib/useSpcAuth"

export default function SpcParserReportsPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const canView = canAccessSpcPage(permissions, "spc-parser-reports", "view")
  const canEdit = canAccessSpcPage(permissions, "spc-parser-reports", "edit")

  useEffect(() => {
    document.title = "SPC Parser Report"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC Parser Report">
      <ParserReportReviewPanel source="spc" canEdit={canEdit} />
    </SpcShell>
  )
}
