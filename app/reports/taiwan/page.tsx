import TaiwanReport from "./TaiwanReportClient"
import { getPublicReportData } from "@/lib/publicMarketData"

export const dynamic = "force-dynamic"

export default async function TaiwanReportPage() {
  const initialData = await getPublicReportData("taiwan")
  return <TaiwanReport initialData={initialData} />
}
