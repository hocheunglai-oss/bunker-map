import ChinaReport from "./ChinaReportClient"
import {
  getEmptyPublicReportData,
  getPublicReportData,
} from "@/lib/publicMarketData"

export const revalidate = 120

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
