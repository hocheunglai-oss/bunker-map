import React from "react"
import { createRoot } from "react-dom/client"
import Homepage from "@/components/Homepage"
import HomepageShell from "@/components/HomepageShell"
import type { HomepageMarketData } from "@/lib/publicMarketData"

declare global {
  interface Window {
    __homepageInitial: HomepageMarketData & { unavailable?: boolean }
    __homepageShellOnly: boolean
    __homepageHarness: { ready: boolean; refresh: (() => void) | null; routes: string[] }
  }
}
const h = window.__homepageHarness = { ready: false, refresh: null, routes: [] } as Window["__homepageHarness"]
const timer = window.setTimeout.bind(window)
// Exercise the component's real scheduled refresh without waiting a minute.
window.setTimeout = ((handler: TimerHandler, milliseconds?: number, ...args: unknown[]) => {
  if (milliseconds === 60000 && typeof handler === "function") { h.refresh = () => handler(...args); return 987654 }
  return timer(handler, milliseconds, ...args)
}) as typeof window.setTimeout
createRoot(document.getElementById("root")!).render(<React.StrictMode>
  {window.__homepageShellOnly ? <HomepageShell initialData={window.__homepageInitial} />
    : <Homepage initialData={window.__homepageInitial} onReady={() => { h.ready = true }} />}
</React.StrictMode>)
