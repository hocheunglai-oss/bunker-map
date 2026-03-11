"use client"

import dynamic from "next/dynamic"

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
})

export default function Home() {
  return (
    <div className="h-screen w-full bg-[#07121f]">
      <MapView />
    </div>
  )
}