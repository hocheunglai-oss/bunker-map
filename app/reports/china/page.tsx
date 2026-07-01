import ChinaReport from "./ChinaReportClient"
import { getPublicReportData } from "@/lib/publicMarketData"

export const dynamic = "force-dynamic"

export default async function ChinaReportPage() {
  const initialData = await getPublicReportData("china")
  return <ChinaReport initialData={initialData} />
}
