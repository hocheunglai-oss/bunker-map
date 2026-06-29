"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { getAdminFolderStyle } from "@/lib/adminFolderTones"
import { clearSpcClientSessionCache, useSpcAuth } from "@/lib/useSpcAuth"
import {
  SPC_PAGE_GROUP_LABELS,
  canAccessSpcPage,
  type SpcPageDefinition,
  type SpcPagePermission,
} from "@/lib/spcPages"

type SpcPageGroup = SpcPageDefinition["group"]
type VisiblePermission = Exclude<SpcPagePermission, "none">

const SPC_GROUP_ORDER: SpcPageGroup[] = ["trading", "contacts", "management"]
const SIDEBAR_COLLAPSED_KEY = "spc-sidebar-collapsed"
const SIDEBAR_GROUPS_KEY = "spc-sidebar-groups"

function defaultExpandedGroups() {
  return SPC_GROUP_ORDER.reduce<Record<SpcPageGroup, boolean>>(
    (groups, group) => {
      groups[group] = true
      return groups
    },
    {} as Record<SpcPageGroup, boolean>,
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

function ToolIcon({ page }: { page: SpcPageDefinition }) {
  if (page.id === "spc-whatsapp") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5.2 19.2 6.4 16A7.5 7.5 0 1 1 9 18.1l-3.8 1.1Z" />
        <path d="M9.2 9.5c.7 2 2 3.4 4 4l1.2-1.2 2.1.8c-.2 1.5-1.1 2.4-2.6 2.4-3.4-.2-5.6-2.3-6.4-6.3.1-1.4.9-2.2 2.2-2.5l.9 2-1.4.8Z" />
      </svg>
    )
  }
  if (page.id === "spc-user-management") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4.5 19c.6-3.3 2.1-5 4.5-5s3.9 1.7 4.5 5" />
        <path d="M16.2 7.2a2.5 2.5 0 0 1 0 4.6M16 14.2c1.8.4 3 1.9 3.5 4.3" />
      </svg>
    )
  }
  if (page.id === "spc-audit-log") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4.5h10v15H7v-15Z" />
        <path d="M9.5 8.5h5M9.5 12h5M9.5 15.5h3.5" />
      </svg>
    )
  }
  if (page.id === "spc-system-health") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 13h4l2-5 4 10 2-5h4" />
      </svg>
    )
  }
  if (page.id === "spc-tech-stack") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 4 8 4-8 4-8-4 8-4Z" />
        <path d="m4 12 8 4 8-4M4 16l8 4 8-4" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4.5h8M9 3.5h6v3H9v-3ZM6 6h12v14H6V6Z" />
      <path d="M8.8 11h6.4M8.8 14h6.4M8.8 17h4.2" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.3a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 0 1 0-7.4Z" />
      <path d="m19.2 13.3.1-1.3-.1-1.3 2-1.5-2-3.4-2.4 1a8 8 0 0 0-2.2-1.3L14.2 3h-4.4l-.4 2.5a8 8 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.5-.1 1.3.1 1.3-2 1.5 2 3.4 2.4-1a8 8 0 0 0 2.2 1.3l.4 2.5h4.4l.4-2.5a8 8 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.5Z" />
    </svg>
  )
}

export function SpcNavigationShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { loading, authenticated, displayName, permissions, pages } = useSpcAuth()
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

  const navigationGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return SPC_GROUP_ORDER.map((group, index) => {
      const entries = pages
        .filter((page) => page.group === group)
        .map((page) => {
          const permission: SpcPagePermission = permissions[page.id] || "none"
          return { page, permission }
        })
        .filter(
          (entry): entry is { page: SpcPageDefinition; permission: VisiblePermission } =>
            entry.permission !== "none",
        )
        .filter(({ page }) => {
          if (!normalizedQuery) return true
          return `${page.label} ${SPC_PAGE_GROUP_LABELS[group]}`
            .toLowerCase()
            .includes(normalizedQuery)
        })

      return {
        group,
        index,
        label: SPC_PAGE_GROUP_LABELS[group],
        editPages: entries.filter((entry) => entry.permission === "edit"),
        viewPages: entries.filter((entry) => entry.permission === "view"),
      }
    }).filter(
      (group) =>
        group.editPages.length > 0 ||
        group.viewPages.length > 0 ||
        (!normalizedQuery &&
          pages.some((page) => page.group === group.group && canAccessSpcPage(permissions, page.id, "view"))),
    )
  }, [pages, permissions, query])

  if (loading || !authenticated) return <>{children}</>

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
      return next
    })
  }

  function toggleGroup(group: SpcPageGroup) {
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
    await fetch("/api/spc/logout", { method: "POST" }).catch(() => undefined)
    clearSpcClientSessionCache()
    window.location.assign("/spc")
  }

  function isActive(page: SpcPageDefinition) {
    if (pathname === page.path) return true
    return (page.matchPrefixes || []).some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  }

  function renderPermissionSection(
    permission: VisiblePermission,
    entries: Array<{ page: SpcPageDefinition; permission: VisiblePermission }>,
  ) {
    if (entries.length === 0) return null

    return (
      <div className={`fc-admin-sidebar-permission is-${permission}`}>
        <div className="fc-admin-sidebar-link-list">
          {entries.map(({ page }) => (
            <Link
              key={page.id}
              href={page.path}
              className={`fc-admin-sidebar-link${isActive(page) ? " is-active" : ""}`}
              aria-current={isActive(page) ? "page" : undefined}
              title={`${page.label} (${permission === "edit" ? "Edit access" : "View access"})`}
            >
              <span className="fc-admin-sidebar-link-main">
                <span className="fc-admin-sidebar-page-icon">
                  <ToolIcon page={page} />
                </span>
                <span>{page.label}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={`fc-admin-app-shell${collapsed ? " is-collapsed" : ""}${mobileOpen ? " is-mobile-open" : ""}`}>
      <button
        type="button"
        className="fc-admin-mobile-menu fc-admin-nav-button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open SPC navigation"
        aria-expanded={mobileOpen}
        aria-controls="spc-sidebar"
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
          aria-label="Expand SPC navigation"
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
        aria-label="Close SPC navigation"
        tabIndex={mobileOpen ? 0 : -1}
      />

      <aside id="spc-sidebar" className="fc-admin-sidebar" data-admin-view-safe="true">
        <div className="fc-admin-sidebar-top">
          <Link href="/spc" className="fc-admin-sidebar-title">
            <img src="/fc-uno-sidebar-logo.png" alt="FC UNO" className="fc-admin-sidebar-logo" />
          </Link>
          <div className="fc-admin-sidebar-controls">
            <button
              type="button"
              className="fc-admin-sidebar-icon-button is-desktop"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand SPC navigation" : "Collapse SPC navigation"}
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
            >
              <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
            </button>
            <button
              type="button"
              className="fc-admin-sidebar-icon-button is-mobile"
              onClick={() => setMobileOpen(false)}
              aria-label="Close SPC navigation"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </div>

        <div className="fc-admin-sidebar-expanded-content">
          <label className="fc-admin-sidebar-search">
            <span className="fc-admin-sidebar-search-icon" aria-hidden="true">⌕</span>
            <span className="sr-only">Search SPC tools</span>
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tools..."
            />
          </label>

          <nav className="fc-admin-sidebar-folders" aria-label="SPC tools">
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
                        <FolderIcon />
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
            <span>{(displayName || "SPC").trim().slice(0, 2).toUpperCase()}</span>
          </div>
          <div className="fc-admin-sidebar-footer-actions">
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
