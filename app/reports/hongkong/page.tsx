import HongKongReport from "./HongKongReportClient"
import { getPublicReportPageData } from "@/lib/publicReportAvailability"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function HongKongReportPage() {
  const initialData = await getPublicReportPageData("hongkong")
  return <HongKongReport initialData={initialData} />
}
