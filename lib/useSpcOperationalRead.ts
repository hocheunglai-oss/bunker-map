"use client"

import { useCallback, useEffect, useRef, useState } from "react"

// Read-only, document-owned requests. Aborting alone is not sufficient: a
// transport/body can settle after abort, so every state update checks ownership.
export function useSpcOperationalRead<T>(url: string, parse: (value: unknown) => T) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState("")
  const request = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(false)
  const cancel = useCallback(() => {
    request.current?.abort()
    request.current = null
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const load = useCallback(async (force: boolean) => {
    if (!mounted.current) return
    cancel()
    const owner = new AbortController()
    request.current = owner
    const owns = () => mounted.current && request.current === owner && !owner.signal.aborted
    setLoading(true)
    setMessage("")
    timer.current = setTimeout(() => {
      if (!owns()) return
      cancel()
      setLoading(false)
      setMessage("The request timed out. Please refresh to retry. Any previously loaded values are not a current check.")
    }, 30_000)
    try {
      const response = await fetch(force ? url + "?refresh=1" : url, { cache: "no-store", signal: owner.signal })
      if (!owns()) return
      if (response.status === 401 || response.status === 403) {
        setData(null)
        setMessage("Your access could not be verified. Please sign in again or check your access.")
        return
      }
      if (!response.ok) throw new Error("Operational data unavailable")
      const payload: unknown = await response.json()
      if (!owns()) return
      setData(parse(payload))
    } catch {
      if (owns()) setMessage("The information could not be refreshed. Please retry. Any previously loaded values are not a current check.")
    } finally {
      if (owns()) { cancel(); setLoading(false) }
    }
  }, [cancel, parse, url])
  useEffect(() => {
    mounted.current = true
    const initialLoad = setTimeout(() => void load(false), 0)
    return () => { mounted.current = false; clearTimeout(initialLoad); cancel() }
  }, [cancel, load])
  return { data, loading, message, refresh: () => void load(true) }
}
