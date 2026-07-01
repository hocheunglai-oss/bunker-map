import HongKongReport from "./HongKongReportClient"
import { getPublicReportData } from "@/lib/publicMarketData"

export const dynamic = "force-dynamic"

export default async function HongKongReportPage() {
  const initialData = await getPublicReportData("hongkong")
  return <HongKongReport initialData={initialData} />
}
