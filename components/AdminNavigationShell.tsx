"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { getAdminFolderStyle } from "@/lib/adminFolderTones"
import {
  clearAdminClientCache,
  fetchAdminClientJson,
  OUTLOOK_ADDRESS_BOOK_CACHE_KEY,
  OUTLOOK_TEMPLATES_CACHE_KEY,
} from "@/lib/adminClientCache"
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

const ADMIN_GROUP_ORDER: AdminPageGroup[] = [
  "office",
  "trading",
  "contacts",
  "reports",
  "management",
]
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

function AdminFolderIcon({ group }: { group: AdminPageGroup }) {
  if (group === "office") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 7V5.8C8 4.8 8.8 4 9.8 4h4.4c1 0 1.8.8 1.8 1.8V7" />
        <path d="M4.5 8.5h15v9.7c0 1-.8 1.8-1.8 1.8H6.3c-1 0-1.8-.8-1.8-1.8V8.5Z" />
        <path d="M4.5 12h15M10 12v1.8h4V12" />
      </svg>
    )
  }

  if (group === "trading") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <path d="M4.5 12h15M12 4c2 2.2 3 4.9 3 8s-1 5.8-3 8M12 4c-2 2.2-3 4.9-3 8s1 5.8 3 8" />
      </svg>
    )
  }

  if (group === "contacts") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.5 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM16.5 11a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z" />
        <path d="M3.5 19c.6-3.3 2-5 4-5s3.4 1.7 4 5M13.1 18.7c.5-2.4 1.7-3.7 3.4-3.7 1.8 0 3 1.3 3.5 3.7" />
      </svg>
    )
  }

  if (group === "reports") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3.8h7l3 3v13.4H7V3.8Z" />
        <path d="M14 3.8V7h3M9.5 11.5h5M9.5 14.5h5M9.5 17.5h3" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.3a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 0 1 0-7.4Z" />
      <path d="m19.2 13.3.1-1.3-.1-1.3 2-1.5-2-3.4-2.4 1a8 8 0 0 0-2.2-1.3L14.2 3h-4.4l-.4 2.5a8 8 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.5-.1 1.3.1 1.3-2 1.5 2 3.4 2.4-1a8 8 0 0 0 2.2 1.3l.4 2.5h4.4l.4-2.5a8 8 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.5Z" />
    </svg>
  )
}

function AdminPageIcon({ page }: { page: AdminPageDefinition }) {
  if (page.id.includes("calendar")) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 4.5v3M18 4.5v3M4.5 8.5h15M6.5 6h11c1.1 0 2 .9 2 2v10.5c0 1.1-.9 2-2 2h-11c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2Z" />
        <path d="M8 12h2M12 12h2M16 12h1M8 16h2M12 16h2" />
      </svg>
    )
  }

  if (page.id === "ccinfo") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <path d="M4.5 12h15M12 4c2 2.2 3 4.9 3 8s-1 5.8-3 8M12 4c-2 2.2-3 4.9-3 8s1 5.8 3 8" />
      </svg>
    )
  }

  if (page.id === "enquiry-worksheet") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 4.5h8M9 3.5h6v3H9v-3ZM6 6h12v14H6V6Z" />
        <path d="M8.8 11h6.4M8.8 14h6.4M8.8 17h4.2" />
      </svg>
    )
  }

  if (page.id === "phonebook" || page.id === "outlook-addressbook") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4h10v16H7V4Z" />
        <path d="M9.3 8.5h5.4M9.3 16h5.4M12 13.4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
      </svg>
    )
  }

  if (page.id === "email-templates") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 7h15v10.5h-15V7Z" />
        <path d="m5 8 7 5 7-5" />
      </svg>
    )
  }

  if (page.id === "whatsapp") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5.2 19.2 6.4 16A7.5 7.5 0 1 1 9 18.1l-3.8 1.1Z" />
        <path d="M9.2 9.5c.7 2 2 3.4 4 4l1.2-1.2 2.1.8c-.2 1.5-1.1 2.4-2.6 2.4-3.4-.2-5.6-2.3-6.4-6.3.1-1.4.9-2.2 2.2-2.5l.9 2-1.4.8Z" />
      </svg>
    )
  }

  if (page.id === "audit-log") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4.5h10v15H7v-15Z" />
        <path d="M9.5 8.5h5M9.5 12h5M9.5 15.5h3.5" />
      </svg>
    )
  }

  if (page.id === "user-management") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4.5 19c.6-3.3 2.1-5 4.5-5s3.9 1.7 4.5 5" />
        <path d="M16.2 7.2a2.5 2.5 0 0 1 0 4.6M16 14.2c1.8.4 3 1.9 3.5 4.3" />
      </svg>
    )
  }

  if (page.id === "system-health") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 13h4l2-5 4 10 2-5h4" />
      </svg>
    )
  }

  if (page.id === "tech-stack") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 4 8 4-8 4-8-4 8-4Z" />
        <path d="m4 12 8 4 8-4M4 16l8 4 8-4" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.8h7l3 3v13.4H7V3.8Z" />
      <path d="M14 3.8V7h3M9.5 11.5h5M9.5 14.5h5M9.5 17.5h3" />
    </svg>
  )
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

    const accessiblePages = pages
      .filter(
        (page) =>
          isAdminRole(role) || canAccessAdminPage(permissions, page.id, "view"),
      )
    const priorityIds = ["outlook-addressbook", "email-templates"]
    const accessiblePaths = [...accessiblePages]
      .sort((a, b) => {
        const aPriority = priorityIds.indexOf(a.id)
        const bPriority = priorityIds.indexOf(b.id)
        if (aPriority === bPriority) return 0
        if (aPriority === -1) return 1
        if (bPriority === -1) return -1
        return aPriority - bPriority
      })
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

    const warmTimer = window.setTimeout(() => {
      if (accessiblePages.some((page) => page.id === "outlook-addressbook")) {
        void fetchAdminClientJson(
          OUTLOOK_ADDRESS_BOOK_CACHE_KEY,
          "/api/outlook-addressbook/bootstrap",
        ).catch(() => undefined)
      }
      if (accessiblePages.some((page) => page.id === "email-templates")) {
        void fetchAdminClientJson(
          OUTLOOK_TEMPLATES_CACHE_KEY,
          "/api/admin/email-templates",
        ).catch(() => undefined)
      }
    }, 350)

    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      window.clearTimeout(warmTimer)
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
    setCollapsed(false)
    setMobileOpen(false)
    window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => undefined)
    clearAdminClientCache()
    window.localStorage.removeItem("bunker_admin_actor")
    window.location.assign("/admin")
  }

  function renderPermissionSection(
    permission: VisiblePermission,
    entries: Array<{ page: AdminPageDefinition; permission: VisiblePermission }>,
  ) {
    if (entries.length === 0) return null

    return (
      <div className={`fc-admin-sidebar-permission is-${permission}`}>
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
                title={`${page.label} (${permission === "edit" ? "Edit access" : "View access"})`}
              >
                <span className="fc-admin-sidebar-link-main">
                  <span className="fc-admin-sidebar-page-icon">
                    <AdminPageIcon page={page} />
                  </span>
                  <span>{page.label}</span>
                </span>
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

      {collapsed ? (
        <button
          type="button"
          className="fc-admin-sidebar-reopen fc-admin-nav-button"
          onClick={toggleCollapsed}
          aria-label="Expand admin navigation"
          title="Expand navigation"
          data-admin-view-safe="true"
        >
          <span aria-hidden="true">›</span>
        </button>
      ) : null}

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
          <Link href="/admin" className="fc-admin-sidebar-title">
            <img
              src="/fc-uno-sidebar-logo.png"
              alt="FC UNO"
              className="fc-admin-sidebar-logo"
            />
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
                  data-folder-group={folder.group}
                  style={getAdminFolderStyle(folder.index)}
                >
                  <button
                    type="button"
                    className="fc-admin-sidebar-folder-tab"
                    onClick={() => toggleGroup(folder.group)}
                    aria-expanded={expanded}
                  >
                    <span className="fc-admin-sidebar-folder-tab-main">
                      <span className="fc-admin-sidebar-folder-icon">
                        <AdminFolderIcon group={folder.group} />
                      </span>
                      <span>{folder.label}</span>
                    </span>
                    <span className="fc-admin-sidebar-folder-toggle" aria-hidden="true">
                      {expanded ? "−" : "+"}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="fc-admin-sidebar-folder-body">
                      {renderPermissionSection("edit", folder.editPages)}
                      {renderPermissionSection("view", folder.viewPages)}
                    </div>
                  ) : null}
                </section>
              )
            })}

            {navigationGroups.length === 0 ? (
              <p className="fc-admin-sidebar-no-results">No accessible tools match.</p>
            ) : null}
          </nav>

        </div>

        <div className="fc-admin-sidebar-footer">
          <div className="fc-admin-sidebar-user">
            <span>{(displayName || "U").trim().slice(0, 2).toUpperCase()}</span>
          </div>
          <div className="fc-admin-sidebar-footer-actions">
            <button type="button" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>
      </aside>

      <div className="fc-admin-app-content">
        {children}
      </div>
    </div>
  )
}
