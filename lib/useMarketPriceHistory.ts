"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { confirmMarketHistoryChange, HistoryValidationError, parseMarketHistorySnapshot, validateMarketHistoryChange, type HistoryMarket, type MarketHistoryChange, type MarketHistorySnapshot } from "@/lib/marketPriceHistory"
import { getMarketDateKey } from "@/lib/priceHistoryRecords"

// One in-flight operation for a page. Failed reads never become editable empty
// data; conflicts/uncertain responses require an explicit reload, keeping inputs.
export function useMarketPriceHistory(market: HistoryMarket, enabled: boolean, canEdit: boolean) {
  const [snapshot, setSnapshot] = useState<MarketHistorySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [changing, setChanging] = useState(false)
  const [message, setMessage] = useState("")
  const [needsReload, setNeedsReload] = useState(false)
  const lock = useRef(false)
  const generation = useRef(0)
  const url = `/api/admin/price-history?market=${market}`

  const reload = useCallback(async () => {
    if (!enabled || lock.current) return false
    lock.current = true
    const current = generation.current
    setLoading(true)
    setChanging(false)
    setMessage("")
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw Error()
      const data = parseMarketHistorySnapshot(await response.json(), market)
      if (generation.current !== current) return false
      setSnapshot(data)
      setNeedsReload(false)
      return true
    } catch {
      if (generation.current === current) {
        setNeedsReload(true)
        setMessage("Saved history could not be loaded completely. Your inputs are unchanged; please reload saved history.")
      }
      return false
    } finally {
      if (generation.current === current) { lock.current = false; setLoading(false) }
    }
  }, [enabled, market, url])

  useEffect(() => {
    const current = ++generation.current
    lock.current = false
    // Start external synchronization after effect setup. Strict Mode's first
    // cleanup invalidates this job, avoiding a duplicate initial read.
    queueMicrotask(() => { if (enabled && generation.current === current) void reload() })
    return () => { generation.current += 1 }
  }, [enabled, reload])

  async function change(day: string, operation: "save" | "delete", values: MarketHistoryChange["values"]) {
    if (!enabled || !canEdit || !snapshot || needsReload || lock.current) return false
    let input: MarketHistoryChange
    try {
      input = validateMarketHistoryChange({ day, operation, expectedPorts: snapshot.ports,
        expectedRows: snapshot.rows.filter(row => getMarketDateKey(row.recorded_at) === day), values }, market)
    } catch (error) {
      setMessage(error instanceof HistoryValidationError ? error.message : "Check the history details.")
      return false
    }
    lock.current = true
    const current = generation.current
    setChanging(true)
    setMessage("")
    try {
      const response = await fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(25_000) })
      if (!response.ok) {
        // Do not echo arbitrary server/internal errors into the page.
        if (response.status === 409) throw Error("Saved history or prices changed while you were editing. Your draft is still here; reload saved history before retrying.")
        if (response.status === 403) throw Error("You do not have permission to change this market's history.")
        throw Error()
      }
      const result = confirmMarketHistoryChange(await response.json(), market, input)
      if (generation.current !== current) return false
      setSnapshot({ market, ports: result.ports, rows: [...snapshot.rows.filter(row => getMarketDateKey(row.recorded_at) !== day), ...result.rows] })
      setMessage(operation === "delete" ? "History day deleted. The public report is unchanged until Publish." : "History saved. The public report is unchanged until Publish.")
      return true
    } catch (error) {
      if (generation.current === current) {
        setNeedsReload(true)
        setMessage(error instanceof Error && /^(Saved history or prices changed|You do not have permission)/.test(error.message) ? error.message
          : "The history change could not be confirmed. Your draft is still here; reload saved history to check before retrying.")
      }
      return false
    } finally {
      if (generation.current === current) { lock.current = false; setChanging(false) }
    }
  }
  return { snapshot, loading, changing, message, needsReload, reload, change,
    ready: enabled && snapshot?.market === market && !loading && !changing && !needsReload }
}
