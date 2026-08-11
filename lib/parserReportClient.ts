export type ParserReportClientSource = "enquiryworksheet" | "spc"

export const PARSER_REPORT_COUNT_CHANGED_EVENT = "fcuno:parser-report-count-changed"

export function notifyParserReportCountChanged(source: ParserReportClientSource) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(PARSER_REPORT_COUNT_CHANGED_EVENT, {
    detail: { source },
  }))
}

export async function fetchParserReportResponse(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 12_000,
) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The report request timed out. Try again.")
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}
