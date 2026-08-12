"use client"

import { useCallback, useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import {
  PARSER_REPORT_COUNT_CHANGED_EVENT,
  fetchParserReportResponse,
  type ParserReportClientSource,
} from "@/lib/parserReportClient"

type ParserReportCountResponse = {
  readyForUserReview?: number
}

export function ParserReportSidebarBadge({
  source,
}: {
  source: ParserReportClientSource
}) {
  const pathname = usePathname()
  const [count, setCount] = useState<number | null>(null)

  const loadCount = useCallback(async () => {
    try {
      const response = await fetchParserReportResponse(
        `/api/parser-reports?source=${source}&summary=1&queue=1`,
        { cache: "no-store" },
      )
      const payload = (await response.json().catch(() => ({}))) as ParserReportCountResponse
      if (!response.ok) throw new Error("Unable to load parser reports.")
      setCount(Math.max(0, Number(payload.readyForUserReview) || 0))
    } catch {
      setCount(null)
    }
  }, [source])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadCount(), 0)

    const handleCountChanged = (event: Event) => {
      const eventSource = (event as CustomEvent<{ source?: unknown }>).detail?.source
      if (!eventSource || eventSource === source) void loadCount()
    }
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void loadCount()
    }

    window.addEventListener(PARSER_REPORT_COUNT_CHANGED_EVENT, handleCountChanged)
    window.addEventListener("focus", loadCount)
    document.addEventListener("visibilitychange", handleVisibility)
    return () => {
      window.clearTimeout(initialLoad)
      window.removeEventListener(PARSER_REPORT_COUNT_CHANGED_EVENT, handleCountChanged)
      window.removeEventListener("focus", loadCount)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [loadCount, pathname, source])

  if (count === null) return null

  return (
    <span
      className={`fc-admin-sidebar-count is-ready${count > 0 ? " has-items" : ""}`}
      aria-label={`${count} parser ${count === 1 ? "report" : "reports"} pending your review`}
      title="Pending your review"
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}
