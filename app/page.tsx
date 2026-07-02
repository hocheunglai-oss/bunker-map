import HomepageClient from "@/components/HomepageClient"
import { getHomepageMarketData } from "@/lib/publicMarketData"

export const revalidate = 120

export default async function Home() {
  const initialData = await getInitialHomepageData()

  return <HomepageClient initialData={initialData} />
}

async function getInitialHomepageData() {
  try {
    return await getHomepageMarketData()
  } catch (error) {
    console.error("Initial homepage data load failed", error)
    return { ports: [], fallbacks: {} }
  }
}
