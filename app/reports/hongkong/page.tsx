import HongKongReport from "./HongKongReportClient"
import {
  getEmptyPublicReportData,
  getPublicReportData,
} from "@/lib/publicMarketData"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function HongKongReportPage() {
  const initialData = await getInitialReportData()
  return <HongKongReport initialData={initialData} />
}

async function getInitialReportData() {
  try {
    return await getPublicReportData("hongkong")
  } catch (error) {
    console.error("Initial Hong Kong report data unavailable", error)
    return getEmptyPublicReportData("hongkong")
  }
}
