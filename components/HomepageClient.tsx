"use client"

import dynamic from "next/dynamic"

const Homepage = dynamic(() => import("@/components/Homepage"), {
  ssr: false,
})

export default function HomepageClient() {
  return (
    <div className="h-screen w-full bg-[#07121f]">
      <Homepage />
    </div>
  )
}
