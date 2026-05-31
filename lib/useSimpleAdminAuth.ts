"use client"

import { useEffect, useState } from "react"
import {
  normaliseAdminPagePermissions,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"

type AuthState = {
  loading: boolean
  authenticated: boolean
  username: string | null
  displayName: string | null
  role: string | null
  permissions: AdminPagePermissionMap
}

export function useSimpleAdminAuth(): AuthState {
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [username, setUsername] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<AdminPagePermissionMap>(
    normaliseAdminPagePermissions(null)
  )

  useEffect(() => {
    async function checkSession() {
      try {
        const response = await fetch("/api/admin/session", {
          cache: "no-store",
        })

        const data = await response.json()
        const isAuthenticated = Boolean(data.authenticated)
        const nextUsername = typeof data.username === "string" ? data.username : null
        const nextDisplayName =
          typeof data.displayName === "string" ? data.displayName : nextUsername
        const nextRole = typeof data.role === "string" ? data.role : null
        const nextPermissions = normaliseAdminPagePermissions(data.permissions)

        setAuthenticated(isAuthenticated)
        setUsername(isAuthenticated ? nextUsername : null)
        setDisplayName(isAuthenticated ? nextDisplayName : null)
        setRole(isAuthenticated ? nextRole : null)
        setPermissions(isAuthenticated ? nextPermissions : normaliseAdminPagePermissions(null))

        if (typeof window !== "undefined") {
          if (isAuthenticated && nextUsername) {
            window.localStorage.setItem(
              "bunker_admin_actor",
              JSON.stringify({
                username: nextUsername,
                displayName: nextDisplayName || nextUsername,
                role: nextRole,
                permissions: nextPermissions,
              })
            )
          } else {
            window.localStorage.removeItem("bunker_admin_actor")
          }
        }
      } catch {
        setAuthenticated(false)
        setUsername(null)
        setDisplayName(null)
        setRole(null)
        setPermissions(normaliseAdminPagePermissions(null))
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("bunker_admin_actor")
        }
      } finally {
        setLoading(false)
      }
    }

    checkSession()
  }, [])

  return { loading, authenticated, username, displayName, role, permissions }
}
