"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { ParserReportReviewPanel } from "@/components/ParserReportReviewPanel"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

export default function AdminParserReportsPage() {
  const router = useRouter()
  const {
    loading: authLoading,
    authenticated,
    permissions,
    role,
  } = useSimpleAdminAuth()
  const canView = isAdminRole(role) || canAccessAdminPage(permissions, "parser-reports", "view")
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "parser-reports", "edit")

  useEffect(() => {
    document.title = "PARSER REPORT - FC Uno"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/admin")
  }, [authLoading, authenticated, canView, router])

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <main className="spc-main" aria-label="FCUNO Parser Report">
      <ParserReportReviewPanel source="enquiryworksheet" canEdit={canEdit} />
    </main>
  )
}
