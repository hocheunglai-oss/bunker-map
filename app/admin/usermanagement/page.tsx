"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ADMIN_PAGE_GROUP_LABELS,
  canAccessAdminPage,
  getFullAdminPagePermissions,
  isAdminRole,
  normaliseAdminPagePermissions,
  normaliseAdminRole,
  type AdminPageDefinition,
  type AdminPagePermission,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"
import { useIsMobile } from "@/lib/useIsMobile"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type ManagedAdminUser = {
  id: string
  username: string
  displayName: string
  role: string
  permissions: AdminPagePermissionMap
  createdAt: string
  updatedAt: string
}

type ManagedAdminRoleDefault = {
  role: string
  permissions: AdminPagePermissionMap
  updatedAt: string | null
  memberCount: number
  hasMixedPermissions: boolean
  persisted: boolean
  isBuiltIn: boolean
}

type UsersResponse = {
  users: ManagedAdminUser[]
  pages: AdminPageDefinition[]
  roleDefaults: ManagedAdminRoleDefault[]
  groupStorage: "table" | "shared-store"
  message?: string
}

type DraftUser = {
  id?: string
  username: string
  displayName: string
  role: string
  password: string
}

type ModalName = "user" | "group" | null

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "18px",
}

const panelStyle: React.CSSProperties = {
  minWidth: 0,
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "20px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 16px 38px #00000012",
  overflow: "hidden",
}

const buttonStyle: React.CSSProperties = {
  minHeight: "36px",
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 850,
  padding: "8px 14px",
  boxShadow: "none",
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "#1473e6",
  background: "#1473e6",
  color: "#fff",
}

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-danger-border)",
  background: "var(--fc-admin-danger-bg)",
  color: "var(--fc-admin-danger-text)",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "42px",
  border: "1px solid var(--fc-input-border)",
  borderRadius: "12px",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-tool-input-text)",
  fontSize: "14px",
  outline: "none",
  padding: "0 12px",
}

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: "7px",
  color: "var(--fc-admin-muted)",
  fontSize: "11px",
  fontWeight: 900,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
}

function createDraftUser(role = "AC"): DraftUser {
  return {
    username: "",
    displayName: "",
    role,
    password: "",
  }
}

function userToDraft(user: ManagedAdminUser): DraftUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: normaliseAdminRole(user.role),
    password: "",
  }
}

function getPermissionLabel(permission: AdminPagePermission) {
  if (permission === "edit") return "Edit"
  if (permission === "view") return "View"
  return "None"
}

function getInitials(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "U"
}

function getErrorMessage(data: unknown, fallback: string) {
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return fallback
}

export default function UserManagementPage() {
  const router = useRouter()
  const isMobile = useIsMobile(920)
  const { loading: authLoading, authenticated, permissions, role, username } = useSimpleAdminAuth()
  const [users, setUsers] = useState<ManagedAdminUser[]>([])
  const [pages, setPages] = useState<AdminPageDefinition[]>([])
  const [roleDefaults, setRoleDefaults] = useState<ManagedAdminRoleDefault[]>([])
  const [selectedRole, setSelectedRole] = useState("AC")
  const [modal, setModal] = useState<ModalName>(null)
  const [draft, setDraft] = useState<DraftUser>(createDraftUser)
  const [newGroupName, setNewGroupName] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "user-management", "edit")
  const selectedGroup = useMemo(
    () => roleDefaults.find((group) => group.role === selectedRole) || roleDefaults[0] || null,
    [roleDefaults, selectedRole]
  )
  const selectedPermissions = selectedGroup
    ? isAdminRole(selectedGroup.role)
      ? getFullAdminPagePermissions(pages)
      : normaliseAdminPagePermissions(selectedGroup.permissions, "view", pages)
    : normaliseAdminPagePermissions(null, "view", pages)
  const groupedPages = useMemo(
    () =>
      pages.reduce<Record<string, AdminPageDefinition[]>>((groups, page) => {
        groups[page.group] = groups[page.group] || []
        groups[page.group].push(page)
        return groups
      }, {}),
    [pages]
  )

  const showMessage = useCallback((nextMessage: string, isError = false) => {
    setMessage(nextMessage)
    setMessageIsError(isError)
  }, [])

  const loadUsers = useCallback(async () => {
    if (!authenticated) return

    setLoading(true)
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" })
      const data = (await response.json()) as UsersResponse

      if (!response.ok) {
        showMessage(data.message || "Failed to load users.", true)
        return
      }

      const nextGroups = data.roleDefaults || []
      setUsers(data.users || [])
      setPages(data.pages || [])
      setRoleDefaults(nextGroups)
      setSelectedRole((current) =>
        nextGroups.some((group) => group.role === current)
          ? current
          : nextGroups.find((group) => group.role === "AC")?.role || nextGroups[0]?.role || "AC"
      )
    } catch {
      showMessage("Failed to load users.", true)
    } finally {
      setLoading(false)
    }
  }, [authenticated, showMessage])

  useEffect(() => {
    document.title = "User Management - FC Uno"
  }, [])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  useEffect(() => {
    if (!modal) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) setModal(null)
    }

    window.addEventListener("keydown", closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [modal, saving])

  function openNewUser() {
    const defaultRole =
      roleDefaults.find((group) => group.role === "AC")?.role || roleDefaults[0]?.role || "AC"
    setDraft(createDraftUser(defaultRole))
    setModal("user")
  }

  function openEditUser(user: ManagedAdminUser) {
    setDraft(userToDraft(user))
    setModal("user")
  }

  function openNewGroup() {
    setNewGroupName("")
    setModal("group")
  }

  function updateDraft<K extends keyof DraftUser>(key: K, value: DraftUser[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function updateRolePermission(pageId: string, permission: AdminPagePermission) {
    if (!selectedGroup || isAdminRole(selectedGroup.role)) return

    setRoleDefaults((current) =>
      current.map((group) =>
        group.role === selectedGroup.role
          ? {
              ...group,
              permissions: {
                ...normaliseAdminPagePermissions(group.permissions, "view", pages),
                [pageId]: permission,
              },
            }
          : group
      )
    )
  }

  async function saveUser() {
    if (!draft.username.trim()) {
      showMessage("Username is required.", true)
      return
    }
    if (!draft.id && !draft.password.trim()) {
      showMessage("Password is required for a new user.", true)
      return
    }

    setSaving(true)
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          user: {
            id: draft.id,
            username: draft.username,
            displayName: draft.displayName,
            role: draft.role,
            password: draft.password,
          },
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        showMessage(getErrorMessage(data, "Failed to save user."), true)
        return
      }

      setModal(null)
      await loadUsers()
      showMessage(draft.id ? "User updated." : "User created.")
    } catch {
      showMessage("Failed to save user.", true)
    } finally {
      setSaving(false)
    }
  }

  async function deleteUser() {
    if (!draft.id) return
    if (!window.confirm(`Delete ${draft.username}?`)) return

    setSaving(true)
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: draft.id }),
      })
      const data = await response.json()

      if (!response.ok) {
        showMessage(getErrorMessage(data, "Failed to delete user."), true)
        return
      }

      setModal(null)
      await loadUsers()
      showMessage("User deleted.")
    } catch {
      showMessage("Failed to delete user.", true)
    } finally {
      setSaving(false)
    }
  }

  async function saveRoleDefault() {
    if (!selectedGroup) return

    setSaving(true)
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-role-default",
          roleDefault: {
            role: selectedGroup.role,
            permissions: selectedPermissions,
          },
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        showMessage(getErrorMessage(data, "Failed to save permission group."), true)
        return
      }

      await loadUsers()
      showMessage(`${selectedGroup.role} permissions saved.`)
    } catch {
      showMessage("Failed to save permission group.", true)
    } finally {
      setSaving(false)
    }
  }

  async function createGroup() {
    const requestedName = newGroupName.trim()
    if (!requestedName) {
      showMessage("Group name is required.", true)
      return
    }

    const nextRole = normaliseAdminRole(requestedName)
    if (roleDefaults.some((group) => group.role === nextRole)) {
      showMessage(`${nextRole} already exists.`, true)
      return
    }

    setSaving(true)
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-role-default",
          roleDefault: {
            role: requestedName,
            permissions: normaliseAdminPagePermissions(null, "view", pages),
          },
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        showMessage(getErrorMessage(data, "Failed to create permission group."), true)
        return
      }

      setSelectedRole(data.roleDefault.role)
      setModal(null)
      await loadUsers()
      showMessage(`${data.roleDefault.role} group created.`)
    } catch {
      showMessage("Failed to create permission group.", true)
    } finally {
      setSaving(false)
    }
  }

  async function deleteGroup() {
    if (!selectedGroup || selectedGroup.isBuiltIn) return
    if (!window.confirm(`Delete the ${selectedGroup.role} permission group?`)) return

    setSaving(true)
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete-role-default",
          roleDefault: { role: selectedGroup.role },
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        showMessage(getErrorMessage(data, "Failed to delete permission group."), true)
        return
      }

      setSelectedRole("AC")
      await loadUsers()
      showMessage(`${selectedGroup.role} group deleted.`)
    } catch {
      showMessage("Failed to delete permission group.", true)
    } finally {
      setSaving(false)
    }
  }

  if (authLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={pageStyle}>
        <button type="button" onClick={() => router.push("/admin")} style={buttonStyle}>
          Go To Admin
        </button>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: "grid", gap: "16px", maxWidth: "1500px", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button type="button" onClick={() => router.push("/admin")} style={buttonStyle}>
            Back
          </button>
          <div>
            <h1
              style={{
                margin: 0,
                color: "var(--fc-admin-heading)",
                fontSize: isMobile ? "22px" : "26px",
                letterSpacing: "0.02em",
              }}
            >
              USER MANAGEMENT
            </h1>
          </div>
        </div>

        {message ? (
          <div
            role="status"
            style={{
              border: `1px solid ${messageIsError ? "var(--fc-admin-danger-border)" : "#1473e655"}`,
              borderRadius: "12px",
              background: messageIsError ? "var(--fc-admin-danger-bg)" : "#1473e612",
              color: messageIsError ? "var(--fc-admin-danger-text)" : "var(--fc-admin-heading)",
              padding: "11px 13px",
              fontSize: "13px",
              fontWeight: 800,
            }}
          >
            {message}
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "minmax(300px, 0.72fr) minmax(560px, 1.58fr)",
            gap: "16px",
            alignItems: "start",
          }}
        >
          <section style={panelStyle} aria-labelledby="users-panel-title">
            <div
              style={{
                minHeight: "58px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "12px 14px",
                borderBottom: "1px solid var(--fc-admin-border-soft)",
                background: "var(--fc-admin-panel-soft-bg)",
              }}
            >
              <div>
                <strong id="users-panel-title" style={{ color: "var(--fc-admin-heading)", fontSize: "14px" }}>
                  Users
                </strong>
                <div style={{ marginTop: "2px", color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                  {users.length} account{users.length === 1 ? "" : "s"}
                </div>
              </div>
              <button
                type="button"
                onClick={openNewUser}
                disabled={!canEdit}
                aria-label="Add user"
                title="Add user"
                style={{
                  width: "38px",
                  height: "38px",
                  border: "1px solid #1473e6",
                  borderRadius: "50%",
                  background: "#1473e6",
                  color: "#fff",
                  cursor: canEdit ? "pointer" : "not-allowed",
                  fontSize: "25px",
                  fontWeight: 400,
                  lineHeight: 1,
                  boxShadow: "0 7px 16px #1473e633",
                }}
              >
                +
              </button>
            </div>

            <div style={{ display: "grid", gap: "9px", padding: "12px" }}>
              {users.map((user) => (
                <div
                  key={user.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "42px minmax(0, 1fr) auto",
                    gap: "10px",
                    alignItems: "center",
                    border: "1px solid var(--fc-admin-border-soft)",
                    borderRadius: "14px",
                    background: "var(--fc-admin-panel-soft-bg)",
                    padding: "10px",
                  }}
                >
                  <div
                    aria-hidden="true"
                    style={{
                      width: "42px",
                      height: "42px",
                      display: "grid",
                      placeItems: "center",
                      borderRadius: "12px",
                      background: "#1473e618",
                      color: "#1473e6",
                      fontSize: "13px",
                      fontWeight: 950,
                    }}
                  >
                    {getInitials(user.displayName)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        overflow: "hidden",
                        color: "var(--fc-admin-heading)",
                        fontSize: "13px",
                        fontWeight: 900,
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {user.displayName}
                    </div>
                    <div
                      style={{
                        marginTop: "3px",
                        overflow: "hidden",
                        color: "var(--fc-admin-muted)",
                        fontSize: "11px",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {user.username}
                    </div>
                    <span
                      style={{
                        display: "inline-flex",
                        marginTop: "7px",
                        border: "1px solid var(--fc-admin-border)",
                        borderRadius: "999px",
                        padding: "3px 7px",
                        color: "var(--fc-admin-muted)",
                        fontSize: "10px",
                        fontWeight: 900,
                      }}
                    >
                      {user.role}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => openEditUser(user)}
                    disabled={!canEdit}
                    style={{ ...buttonStyle, minHeight: "32px", padding: "6px 11px" }}
                  >
                    Edit
                  </button>
                </div>
              ))}

              {loading ? (
                <div style={{ color: "var(--fc-admin-muted)", fontSize: "13px", padding: "12px 4px" }}>
                  Loading users...
                </div>
              ) : users.length === 0 ? (
                <div style={{ color: "var(--fc-admin-muted)", fontSize: "13px", padding: "12px 4px" }}>
                  No database users yet.
                </div>
              ) : null}
            </div>
          </section>

          <section style={panelStyle} aria-labelledby="permissions-panel-title">
            <div
              style={{
                minHeight: "58px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "12px 14px",
                borderBottom: "1px solid var(--fc-admin-border-soft)",
                background: "var(--fc-admin-panel-soft-bg)",
              }}
            >
              <div>
                <strong id="permissions-panel-title" style={{ color: "var(--fc-admin-heading)", fontSize: "14px" }}>
                  Permission Groups
                </strong>
                <div style={{ marginTop: "2px", color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                  New pages are added here automatically
                </div>
              </div>
              <button
                type="button"
                onClick={openNewGroup}
                disabled={!canEdit}
                style={{ ...primaryButtonStyle, minHeight: "34px", padding: "7px 12px" }}
              >
                + Group
              </button>
            </div>

            <div style={{ display: "grid", gap: "16px", padding: isMobile ? "12px" : "14px" }}>
              <div style={{ display: "flex", gap: "7px", flexWrap: "wrap" }}>
                {roleDefaults.map((group) => {
                  const active = selectedGroup?.role === group.role
                  return (
                    <button
                      key={group.role}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelectedRole(group.role)}
                      style={{
                        ...buttonStyle,
                        minHeight: "32px",
                        borderColor: active ? "#1473e6" : "var(--fc-admin-button-border)",
                        background: active ? "#1473e6" : "var(--fc-admin-button-bg)",
                        color: active ? "#fff" : "var(--fc-admin-button-text)",
                        padding: "6px 12px",
                      }}
                    >
                      {group.role}
                    </button>
                  )
                })}
              </div>

              {selectedGroup ? (
                <>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "12px",
                      flexWrap: "wrap",
                      border: "1px solid var(--fc-admin-border-soft)",
                      borderRadius: "14px",
                      background: "var(--fc-admin-panel-soft-bg)",
                      padding: "11px 12px",
                    }}
                  >
                    <div>
                      <div style={{ color: "var(--fc-admin-heading)", fontSize: "14px", fontWeight: 950 }}>
                        {selectedGroup.role}
                      </div>
                      <div style={{ marginTop: "3px", color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                        {selectedGroup.memberCount} member{selectedGroup.memberCount === 1 ? "" : "s"}
                        {isAdminRole(selectedGroup.role) ? " · Full access" : " · Group permissions"}
                      </div>
                    </div>
                    {!selectedGroup.isBuiltIn ? (
                      <button
                        type="button"
                        onClick={deleteGroup}
                        disabled={!canEdit || saving || selectedGroup.memberCount > 0}
                        title={selectedGroup.memberCount > 0 ? "Move all users out of this group first" : "Delete group"}
                        style={{ ...dangerButtonStyle, minHeight: "32px", padding: "6px 11px" }}
                      >
                        Delete Group
                      </button>
                    ) : null}
                  </div>

                  {selectedGroup.hasMixedPermissions && !selectedGroup.persisted ? (
                    <div
                      style={{
                        border: "1px solid #d99b2255",
                        borderRadius: "12px",
                        background: "#d99b2212",
                        color: "var(--fc-admin-panel-text)",
                        padding: "10px 12px",
                        fontSize: "12px",
                        lineHeight: 1.5,
                      }}
                    >
                      Members currently have different access. Saving this group will standardize permission settings for all members.
                    </div>
                  ) : null}

                  {Object.entries(groupedPages).map(([group, groupPages]) => (
                    <div key={group}>
                      <div
                        style={{
                          marginBottom: "8px",
                          color: "var(--fc-admin-heading)",
                          fontSize: "11px",
                          fontWeight: 950,
                          letterSpacing: "0.04em",
                          textTransform: "uppercase",
                        }}
                      >
                        {ADMIN_PAGE_GROUP_LABELS[group as keyof typeof ADMIN_PAGE_GROUP_LABELS] || group}
                      </div>

                      <div style={{ display: "grid", gap: "8px" }}>
                        {groupPages.map((page) => {
                          const permission = selectedPermissions[page.id] || "view"
                          const locked = !canEdit || isAdminRole(selectedGroup.role)

                          return (
                            <div
                              key={page.id}
                              style={{
                                display: "grid",
                                gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "minmax(190px, 1fr) auto",
                                gap: isMobile ? "9px" : "12px",
                                alignItems: "center",
                                border: "1px solid var(--fc-admin-border-soft)",
                                borderRadius: "13px",
                                background: "var(--fc-admin-panel-soft-bg)",
                                padding: "10px 11px",
                              }}
                            >
                              <div>
                                <div style={{ color: "var(--fc-admin-heading)", fontSize: "13px", fontWeight: 900 }}>
                                  {page.label}
                                </div>
                                <div style={{ marginTop: "3px", color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                                  {getPermissionLabel(permission)}
                                </div>
                              </div>

                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "repeat(3, minmax(58px, 1fr))",
                                  gap: "5px",
                                }}
                              >
                                {(["none", "view", "edit"] as AdminPagePermission[]).map((option) => {
                                  const active = permission === option
                                  return (
                                    <button
                                      key={option}
                                      type="button"
                                      aria-pressed={active}
                                      onClick={() => updateRolePermission(page.id, option)}
                                      disabled={locked}
                                      style={{
                                        minHeight: "32px",
                                        border: active
                                          ? "1px solid #1473e6"
                                          : "1px solid var(--fc-admin-border)",
                                        borderRadius: "999px",
                                        background: active ? "#1473e6" : "var(--fc-admin-button-bg)",
                                        color: active ? "#fff" : "var(--fc-admin-button-text)",
                                        cursor: locked ? "not-allowed" : "pointer",
                                        fontSize: "11px",
                                        fontWeight: 900,
                                        opacity: locked && !active ? 0.58 : 1,
                                      }}
                                    >
                                      {getPermissionLabel(option)}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "10px",
                      flexWrap: "wrap",
                      borderTop: "1px solid var(--fc-admin-border-soft)",
                      paddingTop: "14px",
                    }}
                  >
                    <span style={{ color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                      Saving updates every member of this group.
                    </span>
                    <button
                      type="button"
                      onClick={saveRoleDefault}
                      disabled={!canEdit || saving || isAdminRole(selectedGroup.role)}
                      style={primaryButtonStyle}
                    >
                      {saving ? "Saving..." : "Save Permissions"}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {modal ? (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setModal(null)
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "grid",
            placeItems: "center",
            background: "#07111f99",
            backdropFilter: "blur(4px)",
            padding: "18px",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-management-modal-title"
            style={{
              width: "min(100%, 520px)",
              maxHeight: "calc(100vh - 36px)",
              overflowY: "auto",
              border: "1px solid var(--fc-admin-border)",
              borderRadius: "20px",
              background: "var(--fc-admin-panel-bg)",
              color: "var(--fc-admin-panel-text)",
              boxShadow: "0 24px 70px #00000055",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                borderBottom: "1px solid var(--fc-admin-border-soft)",
                padding: "14px 16px",
              }}
            >
              <div>
                <h2
                  id="user-management-modal-title"
                  style={{ margin: 0, color: "var(--fc-admin-heading)", fontSize: "18px" }}
                >
                  {modal === "group" ? "Add Permission Group" : draft.id ? "Edit User" : "Add User"}
                </h2>
                <div style={{ marginTop: "3px", color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                  {modal === "group"
                    ? "New groups start with view access."
                    : "Accounts receive access from their permission group."}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModal(null)}
                disabled={saving}
                aria-label="Close"
                style={{
                  width: "34px",
                  height: "34px",
                  border: "1px solid var(--fc-admin-border)",
                  borderRadius: "50%",
                  background: "var(--fc-admin-button-bg)",
                  color: "var(--fc-admin-button-text)",
                  cursor: saving ? "not-allowed" : "pointer",
                  fontSize: "20px",
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>

            {modal === "user" ? (
              <div style={{ display: "grid", gap: "15px", padding: "16px" }}>
                <label style={labelStyle}>
                  Username
                  <input
                    autoFocus
                    value={draft.username}
                    onChange={(event) => updateDraft("username", event.target.value)}
                    disabled={!canEdit || saving}
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Display Name
                  <input
                    value={draft.displayName}
                    onChange={(event) => updateDraft("displayName", event.target.value)}
                    disabled={!canEdit || saving}
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Password
                  <input
                    value={draft.password}
                    type="password"
                    placeholder={draft.id ? "Leave blank to keep current password" : "Required"}
                    onChange={(event) => updateDraft("password", event.target.value)}
                    disabled={!canEdit || saving}
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Permission Group
                  <select
                    value={draft.role}
                    onChange={(event) => updateDraft("role", event.target.value)}
                    disabled={!canEdit || saving}
                    style={inputStyle}
                  >
                    {roleDefaults.map((group) => (
                      <option key={group.role} value={group.role}>
                        {group.role} ({group.memberCount})
                      </option>
                    ))}
                  </select>
                </label>

                <div
                  style={{
                    display: "flex",
                    justifyContent: draft.id ? "space-between" : "flex-end",
                    gap: "9px",
                    flexWrap: "wrap",
                    borderTop: "1px solid var(--fc-admin-border-soft)",
                    paddingTop: "14px",
                  }}
                >
                  {draft.id ? (
                    <button
                      type="button"
                      onClick={deleteUser}
                      disabled={!canEdit || saving || draft.username === username}
                      style={dangerButtonStyle}
                    >
                      Delete
                    </button>
                  ) : null}
                  <div style={{ display: "flex", gap: "9px", marginLeft: "auto" }}>
                    <button type="button" onClick={() => setModal(null)} disabled={saving} style={buttonStyle}>
                      Cancel
                    </button>
                    <button type="button" onClick={saveUser} disabled={!canEdit || saving} style={primaryButtonStyle}>
                      {saving ? "Saving..." : draft.id ? "Save User" : "Create User"}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: "15px", padding: "16px" }}>
                <label style={labelStyle}>
                  Group Name
                  <input
                    autoFocus
                    value={newGroupName}
                    onChange={(event) => setNewGroupName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !saving) createGroup()
                    }}
                    placeholder="For example: FINANCE"
                    maxLength={40}
                    disabled={!canEdit || saving}
                    style={inputStyle}
                  />
                </label>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "9px",
                    borderTop: "1px solid var(--fc-admin-border-soft)",
                    paddingTop: "14px",
                  }}
                >
                  <button type="button" onClick={() => setModal(null)} disabled={saving} style={buttonStyle}>
                    Cancel
                  </button>
                  <button type="button" onClick={createGroup} disabled={!canEdit || saving} style={primaryButtonStyle}>
                    {saving ? "Creating..." : "Create Group"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
