"use client"

import dynamic from "next/dynamic"
import { useEffect, useState } from "react"
import HomepageShell from "@/components/HomepageShell"
import type { HomepageMarketData } from "@/lib/publicMarketData"

const Homepage = dynamic(() => import("@/components/Homepage"), {
  ssr: false,
  loading: () => null,
})

type HomepageClientProps = {
  initialData: HomepageMarketData
}

export default function HomepageClient({ initialData }: HomepageClientProps) {
  const [shouldLoadExperience, setShouldLoadExperience] = useState(false)
  const [experienceReady, setExperienceReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let frameId = 0
    let idleId: number | null = null
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null

    const load = () => {
      if (!cancelled) setShouldLoadExperience(true)
    }

    frameId = window.requestAnimationFrame(() => {
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(load, { timeout: 900 })
      } else {
        timeoutId = globalThis.setTimeout(load, 250)
      }
    })

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frameId)
      if (idleId != null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleId)
      }
      if (timeoutId != null) globalThis.clearTimeout(timeoutId)
    }
  }, [])

  return (
    <div className="relative h-screen w-full overflow-hidden bg-[#07121f]">
      {!experienceReady && <HomepageShell initialData={initialData} />}
      {shouldLoadExperience && (
        <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
          <Homepage initialData={initialData} onReady={() => setExperienceReady(true)} />
        </div>
      )}
    </div>
  )
}
