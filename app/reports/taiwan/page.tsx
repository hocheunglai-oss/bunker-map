import TaiwanReport from "./TaiwanReportClient"
import {
  getEmptyPublicReportData,
  getPublicReportData,
} from "@/lib/publicMarketData"

export const revalidate = 120

export default async function TaiwanReportPage() {
  const initialData = await getInitialReportData()
  return <TaiwanReport initialData={initialData} />
}

async function getInitialReportData() {
  try {
    return await getPublicReportData("taiwan")
  } catch (error) {
    if (error instanceof Error && error.message.includes("Missing environment variable")) {
      console.error("Initial Taiwan report data unavailable", error)
      return getEmptyPublicReportData("taiwan")
    }
    throw error
  }
}
