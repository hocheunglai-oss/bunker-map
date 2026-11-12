import CompactReport from "./CompactReportClient"
import { getPublicReportPageData } from "@/lib/publicReportAvailability"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function CompactReportPage() {
  const initialData = await getPublicReportPageData("compact")
  return <CompactReport initialData={initialData} />
}
