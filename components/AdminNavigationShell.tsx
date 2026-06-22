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
  getAdminPageByPath,
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

const ACTION_PATTERNS: Array<{
  action: "commit" | "delete" | "proceed" | "caution"
  pattern: RegExp
}> = [
  {
    action: "commit",
    pattern:
      /\b(save|saved|saving|apply|sync|syncing|synced|backup|back\s*up|upload|uploading|import|importing|add|create|creating|new|insert)\b|^\+$/i,
  },
  { action: "delete", pattern: /\b(delete|deleting|remove|removing)\b/i },
  {
    action: "caution",
    pattern: /\b(check|undo|undoing|rebuild|restore)\b/i,
  },
  {
    action: "proceed",
    pattern:
      /\b(refresh|refreshing|send|sending|sent|notify|close|cancel|done|download|export|publish|publishing|published|open|next|previous|retry)\b/i,
  },
]

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

function clearUniversalButtonAttrs(element: HTMLElement) {
  delete element.dataset.adminUniversalButton
  delete element.dataset.adminAction
  delete element.dataset.adminUndoButton
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

  const currentPage = getAdminPageByPath(pathname)
  const currentFolderLabel = currentPage
    ? ADMIN_PAGE_GROUP_LABELS[currentPage.group]
    : ""

  useEffect(() => {
    if (!authenticated || loading || pathname === "/admin") return

    const content = document.querySelector<HTMLElement>(".fc-admin-app-content")
    if (!content) return

    const applyUniversalAdminUi = () => {
      const firstHeading = Array.from(
        content.querySelectorAll<HTMLElement>("h1"),
      ).find((heading) => !heading.closest(".fc-admin-universal-page-header"))
      if (firstHeading) firstHeading.dataset.adminLegacyHeading = "true"
      if (currentFolderLabel) {
        const legacyFolderLabel = Array.from(
          content.querySelectorAll<HTMLElement>("div, p, span"),
        ).find(
          (element) =>
            !element.closest(".fc-admin-universal-page-header") &&
            element.textContent?.trim().toLowerCase() ===
              currentFolderLabel.toLowerCase() &&
            (!firstHeading ||
              Boolean(
                element.compareDocumentPosition(firstHeading) &
                  Node.DOCUMENT_POSITION_FOLLOWING,
              )),
        )
        if (legacyFolderLabel) legacyFolderLabel.dataset.adminLegacyFolder = "true"
      }

      content.querySelectorAll<HTMLElement>("button, a").forEach((element) => {
        if (element.closest(".fc-admin-sidebar")) return
        const label = [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()

        if (/^(back|back to admin)$/i.test(label)) {
          clearUniversalButtonAttrs(element)
          element.dataset.adminLegacyBack = "true"
          return
        }

        if (/^(show|hide)\s+delete/i.test(label)) {
          delete element.dataset.adminAction
          delete element.dataset.adminUndoButton
          element.dataset.adminUniversalButton = "true"
          return
        }

        if (
          element.classList.contains("fc-admin-menu-button") ||
          element.getAttribute("role") === "tab" ||
          element.closest("[role='tablist']") ||
          element.style.borderRadius.includes("0 0") ||
          element.closest("[data-admin-button-style='preserve']")
        ) {
          clearUniversalButtonAttrs(element)
          return
        }

        delete element.dataset.adminAction
        delete element.dataset.adminUndoButton
        const matched = ACTION_PATTERNS.find(({ pattern }) => pattern.test(label))
        if (matched) {
          element.dataset.adminAction = matched.action
          if (/\bundo(?:ing)?\b/i.test(label)) {
            element.dataset.adminUndoButton = "true"
            element.setAttribute("aria-label", label)
            element.setAttribute("title", label)
          }
        }
        element.dataset.adminUniversalButton = "true"
      })

      if (currentPage?.id === "ccinfo") {
        content.querySelectorAll<HTMLElement>("div, p, span").forEach((element) => {
          if (element.textContent?.trim().toLowerCase() === "country and company info") {
            element.dataset.adminDuplicateTitle = "true"
          }
        })
      }
    }

    applyUniversalAdminUi()
    const observer = new MutationObserver(applyUniversalAdminUi)
    observer.observe(content, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [authenticated, currentFolderLabel, currentPage?.id, loading, pathname])

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
              >
                <span>{page.label}</span>
                <span
                  className="fc-admin-sidebar-access-icon"
                  title={permission === "edit" ? "Edit access" : "View access"}
                  aria-label={permission === "edit" ? "Edit access" : "View access"}
                >
                  {permission === "edit" ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 20h4l10.7-10.7a2.1 2.1 0 0 0 0-3L17.7 5.3a2.1 2.1 0 0 0-3 0L4 16v4Zm11.8-12.8 1 1" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                      <circle cx="12" cy="12" r="2.8" />
                    </svg>
                  )}
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
            FC UNO
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
