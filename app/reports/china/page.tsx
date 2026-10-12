import ChinaReport from "./ChinaReportClient"
import {
  getEmptyPublicReportData,
  getPublicReportData,
} from "@/lib/publicMarketData"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function ChinaReportPage() {
  const initialData = await getInitialReportData()
  return <ChinaReport initialData={initialData} />
}

async function getInitialReportData() {
  try {
    return await getPublicReportData("china")
  } catch (error) {
    console.error("Initial China report data unavailable", error)
    return getEmptyPublicReportData("china")
  }
}
