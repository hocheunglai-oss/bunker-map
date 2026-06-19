"use client"

import Image from "next/image"
import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { getAdminFolderStyle } from "@/lib/adminFolderTones"
import {
  ADMIN_PAGE_GROUP_LABELS,
  canAccessAdminPage,
  isAdminRole,
  type AdminPageDefinition,
  type AdminPagePermission,
} from "@/lib/adminPages"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type AdminPageGroup = AdminPageDefinition["group"]
type VisiblePermission = Exclude<AdminPagePermission, "none">

const ADMIN_GROUP_ORDER = Object.keys(ADMIN_PAGE_GROUP_LABELS) as AdminPageGroup[]
const SIDEBAR_COLLAPSED_KEY = "fc-admin-sidebar-collapsed"
const SIDEBAR_GROUPS_KEY = "fc-admin-sidebar-groups"

function defaultExpandedGroups() {
  return ADMIN_GROUP_ORDER.reduce<Record<AdminPageGroup, boolean>>(
    (groups, group) => {
      groups[group] = true
      return groups
    },
    {} as Record<AdminPageGroup, boolean>,
  )
}

function readStoredGroups() {
  if (typeof window === "undefined") return defaultExpandedGroups()

  try {
    const value = window.localStorage.getItem(SIDEBAR_GROUPS_KEY)
    if (!value) return defaultExpandedGroups()
    return { ...defaultExpandedGroups(), ...JSON.parse(value) }
  } catch {
    return defaultExpandedGroups()
  }
}

export function AdminNavigationShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { loading, authenticated, displayName, permissions, role, pages } =
    useSimpleAdminAuth()
  const [query, setQuery] = useState("")
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState(defaultExpandedGroups)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true")
    setExpandedGroups(readStoredGroups())
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!mobileOpen) return

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false)
    }

    document.addEventListener("keydown", closeOnEscape)
    return () => document.removeEventListener("keydown", closeOnEscape)
  }, [mobileOpen])

  useEffect(() => {
    if (!authenticated || loading) return

    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)

      if (event.key === "/" && !typing) {
        event.preventDefault()
        setCollapsed(false)
        if (window.matchMedia("(max-width: 980px)").matches) {
          setMobileOpen(true)
        }
        window.requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    }

    document.addEventListener("keydown", focusSearch)
    return () => document.removeEventListener("keydown", focusSearch)
  }, [authenticated, loading])

  useEffect(() => {
    if (!authenticated || loading) return

    const accessiblePaths = pages
      .filter(
        (page) =>
          isAdminRole(role) || canAccessAdminPage(permissions, page.id, "view"),
      )
      .map((page) => page.path)
      .filter((path) => path !== pathname)

    let cancelled = false
    let nextIndex = 0
    let timer: number | undefined

    const prefetchNext = () => {
      if (cancelled || nextIndex >= accessiblePaths.length) return
      router.prefetch(accessiblePaths[nextIndex])
      nextIndex += 1
      timer = window.setTimeout(prefetchNext, 180)
    }

    const idleCallback =
      "requestIdleCallback" in window
        ? window.requestIdleCallback(prefetchNext, { timeout: 1200 })
        : undefined

    if (idleCallback === undefined) {
      timer = window.setTimeout(prefetchNext, 500)
    }

    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      if (idleCallback !== undefined && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleCallback)
      }
    }
  }, [authenticated, loading, pages, pathname, permissions, role, router])

  const navigationGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return ADMIN_GROUP_ORDER.map((group, index) => {
      const entries = pages
        .filter((page) => page.group === group)
        .map((page) => {
          const permission: AdminPagePermission = isAdminRole(role)
            ? "edit"
            : permissions[page.id] || "none"
          return { page, permission }
        })
        .filter(
          (
            entry,
          ): entry is {
            page: AdminPageDefinition
            permission: VisiblePermission
          } => entry.permission !== "none",
        )
        .filter(({ page }) => {
          if (!normalizedQuery) return true
          return `${page.label} ${ADMIN_PAGE_GROUP_LABELS[group]}`
            .toLowerCase()
            .includes(normalizedQuery)
        })

      return {
        group,
        index,
        label: ADMIN_PAGE_GROUP_LABELS[group],
        editPages: entries.filter((entry) => entry.permission === "edit"),
        viewPages: entries.filter((entry) => entry.permission === "view"),
      }
    }).filter(
      (group) =>
        group.editPages.length > 0 ||
        group.viewPages.length > 0 ||
        (!normalizedQuery &&
          pages.some(
            (page) =>
              page.group === group.group &&
              (isAdminRole(role) || canAccessAdminPage(permissions, page.id, "view")),
          )),
    )
  }, [pages, permissions, query, role])

  if (loading || !authenticated) {
    return <>{children}</>
  }

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
      return next
    })
  }

  function toggleGroup(group: AdminPageGroup) {
    setExpandedGroups((current) => {
      const next = { ...current, [group]: !current[group] }
      window.localStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify(next))
      return next
    })
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" })
    window.localStorage.removeItem("bunker_admin_actor")
    router.push("/admin")
    router.refresh()
  }

  function renderPermissionSection(
    label: "EDIT" | "VIEW",
    entries: Array<{ page: AdminPageDefinition; permission: VisiblePermission }>,
  ) {
    if (entries.length === 0) return null

    return (
      <div className={`fc-admin-sidebar-permission is-${label.toLowerCase()}`}>
        <div className="fc-admin-sidebar-permission-label">
          <span aria-hidden="true" />
          {label}
        </div>
        <div className="fc-admin-sidebar-link-list">
          {entries.map(({ page }) => {
            const active =
              pathname === page.path ||
              (page.matchPrefixes || []).some(
                (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
              )

            return (
              <Link
                key={page.id}
                href={page.path}
                className={`fc-admin-sidebar-link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <span>{page.label}</span>
                <span className="fc-admin-sidebar-link-access">{label}</span>
              </Link>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`fc-admin-app-shell${collapsed ? " is-collapsed" : ""}${
        mobileOpen ? " is-mobile-open" : ""
      }`}
    >
      <button
        type="button"
        className="fc-admin-mobile-menu fc-admin-nav-button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open admin navigation"
        aria-expanded={mobileOpen}
        aria-controls="fc-admin-sidebar"
        data-admin-view-safe="true"
      >
        <span aria-hidden="true">☰</span>
        Tools
      </button>

      <button
        type="button"
        className="fc-admin-sidebar-backdrop"
        onClick={() => setMobileOpen(false)}
        aria-label="Close admin navigation"
        tabIndex={mobileOpen ? 0 : -1}
      />

      <aside
        id="fc-admin-sidebar"
        className="fc-admin-sidebar"
        data-admin-view-safe="true"
      >
        <div className="fc-admin-sidebar-top">
          <Link href="/admin" className="fc-admin-sidebar-brand" aria-label="Admin dashboard">
            <Image src="/uno-transparent.png" alt="" width={48} height={56} />
            <span>
              <strong>FC UNO</strong>
              <small>ADMIN TOOLS</small>
            </span>
          </Link>

          <div className="fc-admin-sidebar-controls">
            <button
              type="button"
              className="fc-admin-sidebar-icon-button is-desktop"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand admin navigation" : "Collapse admin navigation"}
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
            >
              <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
            </button>
            <button
              type="button"
              className="fc-admin-sidebar-icon-button is-mobile"
              onClick={() => setMobileOpen(false)}
              aria-label="Close admin navigation"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </div>

        <div className="fc-admin-sidebar-expanded-content">
          <label className="fc-admin-sidebar-search">
            <span className="fc-admin-sidebar-search-icon" aria-hidden="true">⌕</span>
            <span className="sr-only">Search admin tools</span>
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tools..."
            />
          </label>

          <nav className="fc-admin-sidebar-folders" aria-label="Admin tools">
            {navigationGroups.map((folder) => {
              const expanded = query.trim() ? true : expandedGroups[folder.group]

              return (
                <section
                  key={folder.group}
                  className={`fc-admin-sidebar-folder${expanded ? " is-expanded" : ""}`}
                  style={getAdminFolderStyle(folder.index)}
                >
                  <button
                    type="button"
                    className="fc-admin-sidebar-folder-tab"
                    onClick={() => toggleGroup(folder.group)}
                    aria-expanded={expanded}
                  >
                    <span>{folder.label}</span>
                    <span aria-hidden="true">{expanded ? "−" : "+"}</span>
                  </button>
                  {expanded ? (
                    <div className="fc-admin-sidebar-folder-body">
                      {renderPermissionSection("EDIT", folder.editPages)}
                      {renderPermissionSection("VIEW", folder.viewPages)}
                    </div>
                  ) : null}
                </section>
              )
            })}

            {navigationGroups.length === 0 ? (
              <p className="fc-admin-sidebar-no-results">No accessible tools match.</p>
            ) : null}
          </nav>

          <div className="fc-admin-sidebar-permission-key" aria-label="Permission key">
            <div><span className="is-edit" /> EDIT — changes allowed</div>
            <div><span className="is-view" /> VIEW — read only</div>
            <div><span className="is-none" /> NONE — tool hidden</div>
          </div>
        </div>

        <div className="fc-admin-sidebar-footer">
          <div className="fc-admin-sidebar-user">
            <span>{(displayName || "U").slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{displayName || "Admin user"}</strong>
              <small>{isAdminRole(role) ? "ADMIN · FULL EDIT" : "PERMISSION CONTROLLED"}</small>
            </div>
          </div>
          <div className="fc-admin-sidebar-footer-actions">
            <Link href="/admin" className="fc-admin-sidebar-footer-link">
              Dashboard
            </Link>
            <button type="button" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
      </aside>

      <div className="fc-admin-app-content">{children}</div>
    </div>
  )
}
