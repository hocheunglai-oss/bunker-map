import "server-only"

import { getCache } from "@vercel/functions"
import { after } from "next/server"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import {
  getEmptyPublicReportData,
  getPublicReportData,
  PublicReportConnectionError,
  type PublicReportPageData,
  type ReportSnapshotKey,
} from "@/lib/publicMarketData"
import { parsePublicReportPayload } from "@/lib/publicReportValidation"

const COPY_TTL_SECONDS = 24 * 60 * 60

function reportCopies() {
  return getCache({ namespace: `public-report-copies-v1:${fcunoConnectionPolicy.vercel.projectId}` })
}

export async function readAndRememberPublicReport<Key extends ReportSnapshotKey>(key: Key) {
  const report = await getPublicReportData(key)
  const verifiedAt = Date.now()

  // Remember confirmed absence as well as a published report. An empty copy
  // is ineligible for fallback.
  after(async () => {
    try {
      await reportCopies().set(key, { verifiedAt, report }, { ttl: COPY_TTL_SECONDS })
    } catch {
      console.warn("Could not keep a copy of the public report", key)
    }
  })
  return report
}

async function readPreviousReport<Key extends ReportSnapshotKey>(key: Key): Promise<PublicReportPageData<Key> | null> {
  try {
    const copy = await reportCopies().get(key)
    if (!copy || typeof copy !== "object" || !("verifiedAt" in copy) || !("report" in copy)) return null

    const { verifiedAt } = copy
    if (typeof verifiedAt !== "number" || !Number.isFinite(verifiedAt)) return null
    const age = Date.now() - verifiedAt
    if (age < 0 || age >= COPY_TTL_SECONDS * 1000) return null

    const report = parsePublicReportPayload(copy.report, key)
    return report.snapshot && !report.unavailable ? { ...report, previousReport: true } : null
  } catch {
    console.warn("Could not read a copy of the public report", key)
    return null
  }
}

export async function getPublicReportPageData<Key extends ReportSnapshotKey>(key: Key): Promise<PublicReportPageData<Key>> {
  try {
    return await readAndRememberPublicReport(key)
  } catch (error) {
    console.error("Initial public report data unavailable", key, error)
    if (error instanceof PublicReportConnectionError) {
      const previousReport = await readPreviousReport(key)
      if (previousReport) return previousReport
    }
    return getEmptyPublicReportData(key)
  }
}
