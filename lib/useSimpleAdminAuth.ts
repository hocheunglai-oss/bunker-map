"use client"

import { useEffect, useState } from "react"

type AuthState = {
  loading: boolean
  authenticated: boolean
}

export function useSimpleAdminAuth(): AuthState {
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)

  useEffect(() => {
    async function checkSession() {
      try {
        const response = await fetch("/api/admin/session", {
          cache: "no-store",
        })

        const data = await response.json()
        setAuthenticated(Boolean(data.authenticated))
      } catch {
        setAuthenticated(false)
      } finally {
        setLoading(false)
      }
    }

    checkSession()
  }, [])

  return { loading, authenticated }
}
