"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ADMIN_PAGE_GROUP_LABELS,
  canAccessAdminPage,
  isAdminRole,
  type AdminPageDefinition,
} from "@/lib/adminPages"
import { getAdminFolderStyle } from "@/lib/adminFolderTones"
import { getAdminPagesByGroupFromPages } from "@/lib/adminPageRegistry"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type AdminPageGroup = AdminPageDefinition["group"]

const ADMIN_GROUP_ORDER = Object.keys(ADMIN_PAGE_GROUP_LABELS) as AdminPageGroup[]

export default function AdminPage() {
  const router = useRouter()
  const { loading, authenticated, displayName, permissions, role, pages } = useSimpleAdminAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    document.title = "Admin - FC Uno"
  }, [])

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setMessage("")

    const response = await fetch("/api/admin/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    })

    const data = await response.json()

    if (!response.ok) {
      setMessage(data.message || "Login failed.")
      setSubmitting(false)
      return
    }

    if (data.user?.username) {
      window.localStorage.setItem(
        "bunker_admin_actor",
        JSON.stringify({
          username: data.user.username,
          displayName: data.user.displayName || data.user.username,
          role: data.user.role || null,
          permissions: data.user.permissions || {},
          pages: data.user.pages || [],
        })
      )
    }

    window.location.reload()
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", {
      method: "POST",
    })

    window.localStorage.removeItem("bunker_admin_actor")
    window.location.reload()
  }

  function visiblePages(group: AdminPageGroup) {
    return getAdminPagesByGroupFromPages(group, pages).filter(
      (page) => isAdminRole(role) || canAccessAdminPage(permissions, page.id, "view")
    )
  }

  const folderGroups = ADMIN_GROUP_ORDER.map((group, index) => ({
    group,
    label: ADMIN_PAGE_GROUP_LABELS[group],
    pages: visiblePages(group),
    style: getAdminFolderStyle(index),
  }))
  if (loading) {
    return (
      <div className="fc-admin-folder-page">
        <div className="fc-admin-loading">Loading...</div>
      </div>
    )
  }

  return (
    <div className="fc-admin-folder-page">
      <div className="fc-admin-folder-shell">
        <aside className={`fc-admin-access-panel${authenticated ? " is-authenticated" : ""}`}>
          <div className="fc-admin-access-body">
            <Link href="/" className="fc-admin-logo-link">
              <Image
                src="/uno-transparent.png"
                alt="Bunker Map"
                className="fc-admin-logo"
                width={180}
                height={156}
                priority
              />
            </Link>

            {authenticated ? (
              <>
                {displayName ? <p className="fc-admin-signed-in">Signed in as {displayName}</p> : null}
                <button
                  type="button"
                  onClick={handleLogout}
                  className="fc-admin-auth-button fc-admin-auth-button-danger"
                >
                  Logout
                </button>
              </>
            ) : (
              <form onSubmit={handleLogin} className="fc-admin-login-form">
                <label className="fc-admin-auth-field">
                  <span>Username</span>
                  <input
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    autoComplete="username"
                    className="fc-admin-auth-input"
                  />
                </label>

                <label className="fc-admin-auth-field">
                  <span>Password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    className="fc-admin-auth-input"
                  />
                </label>

                <button
                  type="submit"
                  disabled={submitting}
                  className="fc-admin-auth-button fc-admin-auth-button-primary"
                >
                  {submitting ? "Signing in..." : "Login"}
                </button>

                {message ? <p className="fc-admin-auth-message">{message}</p> : null}
              </form>
            )}

            <button
              type="button"
              onClick={() => router.push("/")}
              className="fc-admin-auth-button fc-admin-auth-button-secondary"
            >
              Back
            </button>
          </div>
        </aside>

        <main className="fc-admin-folder-workspace">
          <div className={`fc-admin-folder-grid${authenticated ? "" : " is-locked"}`}>
            {folderGroups.map((folder) => (
              <section
                key={folder.group}
                className={`fc-admin-folder${authenticated ? "" : " is-locked"}`}
                style={folder.style}
                aria-labelledby={authenticated ? `admin-folder-${folder.group}` : undefined}
                aria-label={authenticated ? undefined : folder.label}
              >
                {authenticated ? (
                  <div id={`admin-folder-${folder.group}`} className="fc-admin-folder-tab">
                    <span>{folder.label}</span>
                  </div>
                ) : null}

                <div className="fc-admin-folder-body">
                  {authenticated ? (
                    folder.pages.length > 0 ? (
                      <div className="fc-admin-file-list">
                        {folder.pages.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => router.push(item.path)}
                            className="fc-admin-file-label"
                          >
                            <span>{item.label}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="fc-admin-folder-empty">No tools assigned.</p>
                    )
                  ) : (
                    <div className="fc-admin-folder-preview" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>
    </div>
  )
}
