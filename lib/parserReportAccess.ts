import type { ParserReportSource } from "@/lib/parserReports"

export function parserReportAccessPage(
  source: ParserReportSource,
  reviewQueue: boolean,
) {
  if (source === "spc") {
    return reviewQueue ? "spc-parser-reports" : "spc-buyer-enquiries"
  }
  return reviewQueue ? "parser-reports" : "enquiry-worksheet"
}
