import HongKongReport from "./HongKongReportClient"
import {
  getEmptyPublicReportData,
  getPublicReportData,
} from "@/lib/publicMarketData"

export const revalidate = 120

export default async function HongKongReportPage() {
  const initialData = await getInitialReportData()
  return <HongKongReport initialData={initialData} />
}

async function getInitialReportData() {
  try {
    return await getPublicReportData("hongkong")
  } catch (error) {
    if (error instanceof Error && error.message.includes("Missing environment variable")) {
      console.error("Initial Hong Kong report data unavailable", error)
      return getEmptyPublicReportData("hongkong")
    }
    throw error
  }
}
