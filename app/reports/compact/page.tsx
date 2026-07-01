import CompactReport from "./CompactReportClient"
import { getPublicReportData } from "@/lib/publicMarketData"

export const dynamic = "force-dynamic"

export default async function CompactReportPage() {
  const initialData = await getPublicReportData("compact")
  return <CompactReport initialData={initialData} />
}
