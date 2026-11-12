import TaiwanReport from "./TaiwanReportClient"
import { getPublicReportPageData } from "@/lib/publicReportAvailability"

export const dynamic = "force-dynamic"
export const revalidate = 0

export default async function TaiwanReportPage() {
  const initialData = await getPublicReportPageData("taiwan")
  return <TaiwanReport initialData={initialData} />
}
