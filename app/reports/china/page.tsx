import ChinaReport from "./ChinaReportClient"
import { getPublicReportPageData } from "@/lib/publicReportAvailability"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function ChinaReportPage() {
  const initialData = await getPublicReportPageData("china")
  return <ChinaReport initialData={initialData} />
}
