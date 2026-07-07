import CompactReport from "./CompactReportClient"
import {
  getEmptyPublicReportData,
  getPublicReportData,
} from "@/lib/publicMarketData"

export const revalidate = 120

export default async function CompactReportPage() {
  const initialData = await getInitialReportData()
  return <CompactReport initialData={initialData} />
}

async function getInitialReportData() {
  try {
    return await getPublicReportData("compact")
  } catch (error) {
    if (error instanceof Error && error.message.includes("Missing environment variable")) {
      console.error("Initial compact report data unavailable", error)
      return getEmptyPublicReportData("compact")
    }
    throw error
  }
}
