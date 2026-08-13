"use client"

import Link from "next/link"
import Image from "next/image"
import { useEffect, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { ParserReportSidebarBadge } from "@/components/ParserReportSidebarBadge"
import { SpcMobileModeControl } from "@/components/SpcMobileModeControl"
import { getAdminFolderStyle } from "@/lib/adminFolderTones"
import { clearSpcClientSessionCache, useSpcAuth } from "@/lib/useSpcAuth"
import {
  SPC_PAGE_GROUP_LABELS,
  canAccessSpcPage,
  type SpcPageDefinition,
  type SpcPagePermission,
} from "@/lib/spcPages"
import { getSpcSessionPresentationLabel } from "@/lib/spcSessionPresentation"

type SpcPageGroup = SpcPageDefinition["group"]
type VisiblePermission = Exclude<SpcPagePermission, "none">

const SPC_GROUP_ORDER: SpcPageGroup[] = ["trading", "records", "market", "management"]
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

export function SpcNavigationShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const {
    loading,
    authenticated,
    username,
    displayName,
    role,
    mustChangePassword,
    permissions,
    pages,
  } = useSpcAuth()
  const [query, setQuery] = useState("")
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState(defaultExpandedGroups)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sessionPresentationLabel = getSpcSessionPresentationLabel({
    role,
    displayName,
    username,
  })

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true")
    setExpandedGroups(readStoredGroups())
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  useEffect(() => {
    if (
      loading ||
      !authenticated ||
      !mustChangePassword ||
      pathname === "/spc"
    ) {
      return
    }

    router.replace("/spc")
  }, [authenticated, loading, mustChangePassword, pathname, router])

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
        .filter((page) => page.group === group && page.id !== "spc-readme")
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

  if (loading || !authenticated || mustChangePassword) {
    if (!loading && authenticated && mustChangePassword && pathname !== "/spc") {
      return <div className="spc-loading">Loading password change...</div>
    }
    return <>{children}</>
  }

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
              prefetch={false}
              className={`fc-admin-sidebar-link${isActive(page) ? " is-active" : ""}`}
              aria-current={isActive(page) ? "page" : undefined}
              title={`${page.label} (${permission === "edit" ? "Edit access" : "View access"})`}
              onPointerEnter={() => router.prefetch(page.path)}
              onFocus={() => router.prefetch(page.path)}
            >
              <span className="fc-admin-sidebar-link-main">
                <span>{page.label}</span>
              </span>
              {page.id === "spc-parser-reports" ? (
                <ParserReportSidebarBadge source="spc" />
              ) : null}
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
            <Image src="/spc-sidebar-logo.png" alt="Singapore Purchasing Center" width={800} height={143} className="fc-admin-sidebar-logo is-spc-logo" />
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
          <SpcMobileModeControl />
          <div className="fc-admin-sidebar-footer-meta">
            <div
              className="fc-admin-sidebar-user"
              title={sessionPresentationLabel || "SPC"}
              aria-label={`Signed in as ${sessionPresentationLabel || "SPC"}`}
            >
              <span aria-hidden="true">
                {(sessionPresentationLabel || "SPC").slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div className="fc-admin-sidebar-footer-actions">
              <button type="button" onClick={handleLogout}>
                Logout
              </button>
            </div>
          </div>
        </div>
      </aside>

      <div className="fc-admin-app-content">{children}</div>
    </div>
  )
}
