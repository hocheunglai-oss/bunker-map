"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  ADMIN_ROLE_IDS,
  ADMIN_PAGE_GROUP_LABELS,
  canAccessAdminPage,
  getFullAdminPagePermissions,
  isAdminRole,
  normaliseAdminRole,
  normaliseAdminPagePermissions,
  type AdminRoleId,
  type AdminPageDefinition,
  type AdminPagePermission,
  type AdminPagePermissionMap,
} from "@/lib/adminPages"
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

type UsersResponse = {
  users: ManagedAdminUser[]
  pages: AdminPageDefinition[]
  roleDefaults: ManagedAdminRoleDefault[]
  message?: string
}

type ManagedAdminRoleDefault = {
  role: AdminRoleId
  permissions: AdminPagePermissionMap
  updatedAt: string | null
}

type DraftUser = {
  id?: string
  username: string
  displayName: string
  role: AdminRoleId
  password: string
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "18px",
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px #00000010",
  overflow: "hidden",
}

const sectionHeaderStyle: React.CSSProperties = {
  minHeight: "42px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-admin-panel-soft-bg)",
}

const buttonStyle: React.CSSProperties = {
  minHeight: "34px",
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 800,
  padding: "8px 12px",
  boxShadow: "none",
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-primary-button-bg)",
  background: "var(--fc-admin-primary-button-bg)",
  color: "var(--fc-admin-primary-button-text)",
}

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-danger-border)",
  background: "var(--fc-admin-danger-bg)",
  color: "var(--fc-admin-danger-text)",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "36px",
  border: "1px solid var(--fc-input-border)",
  borderRadius: "12px",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-tool-input-text)",
  fontSize: "13px",
  outline: "none",
  padding: "0 10px",
}

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: "6px",
  color: "var(--fc-admin-muted)",
  fontSize: "11px",
  fontWeight: 900,
  textTransform: "uppercase",
}

function createDraftUser(): DraftUser {
  return {
    username: "",
    displayName: "",
    role: "AC",
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function getDefaultPermissionsForRole(
  role: AdminRoleId,
  roleDefaults: ManagedAdminRoleDefault[],
  pages: AdminPageDefinition[]
) {
  if (isAdminRole(role)) return getFullAdminPagePermissions(pages)

  const roleDefault = roleDefaults.find((item) => item.role === role)
  return normaliseAdminPagePermissions(roleDefault?.permissions, "view", pages)
}

export default function UserManagementPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, role, username } = useSimpleAdminAuth()
  const [users, setUsers] = useState<ManagedAdminUser[]>([])
  const [pages, setPages] = useState<AdminPageDefinition[]>([])
  const [roleDefaults, setRoleDefaults] = useState<ManagedAdminRoleDefault[]>([])
  const [selectedRole, setSelectedRole] = useState<AdminRoleId>("AC")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftUser>(createDraftUser)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingRoleDefault, setSavingRoleDefault] = useState(false)
  const [message, setMessage] = useState("")

  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "user-management", "edit")
  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedId) || null,
    [selectedId, users]
  )
  const selectedRoleIsAdmin = isAdminRole(selectedRole)
  const roleDefaultPermissions = getDefaultPermissionsForRole(selectedRole, roleDefaults, pages)

  const groupedPages = useMemo(() => {
    return pages.reduce<Record<string, AdminPageDefinition[]>>((groups, page) => {
      groups[page.group] = groups[page.group] || []
      groups[page.group].push(page)
      return groups
    }, {})
  }, [pages])

  const loadUsers = useCallback(async (preferredSelectedId?: string | null) => {
    if (!authenticated) return

    setLoading(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" })
      const data = (await response.json()) as UsersResponse

      if (!response.ok) {
        setMessage(data.message || "Failed to load users.")
        return
      }

      setUsers(data.users || [])
      setPages(data.pages || [])
      setRoleDefaults(data.roleDefaults || [])

      setSelectedId((currentSelectedId) => {
        const desiredSelectedId =
          preferredSelectedId !== undefined ? preferredSelectedId : currentSelectedId
        const nextSelectedId =
          desiredSelectedId && data.users.some((user) => user.id === desiredSelectedId)
            ? desiredSelectedId
            : data.users[0]?.id || null

        setDraft(
          nextSelectedId
            ? userToDraft(data.users.find((user) => user.id === nextSelectedId)!)
            : createDraftUser()
        )

        return nextSelectedId
      })
    } catch {
      setMessage("Failed to load users.")
    } finally {
      setLoading(false)
    }
  }, [authenticated])

  useEffect(() => {
    document.title = "User Management - FC Uno"
  }, [])

  useEffect(() => {
    loadUsers()
  }, [loadUsers])

  function selectUser(user: ManagedAdminUser) {
    setSelectedId(user.id)
    setDraft(userToDraft(user))
    setMessage("")
  }

  function startNewUser() {
    setSelectedId(null)
    setDraft(createDraftUser())
    setMessage("")
  }

  function updateDraft<K extends keyof DraftUser>(key: K, value: DraftUser[K]) {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }))
  }

  function updateDraftRole(nextRole: AdminRoleId) {
    setDraft((current) => ({
      ...current,
      role: nextRole,
    }))
    setSelectedRole(nextRole)
  }

  function updateRolePermission(pageId: string, permission: AdminPagePermission) {
    setRoleDefaults((current) => {
      const existing = current.find((roleDefault) => roleDefault.role === selectedRole)
      const nextRoleDefault: ManagedAdminRoleDefault = {
        role: selectedRole,
        updatedAt: existing?.updatedAt || null,
        permissions: {
          ...roleDefaultPermissions,
          [pageId]: permission,
        },
      }

      return existing
        ? current.map((roleDefault) =>
            roleDefault.role === selectedRole ? nextRoleDefault : roleDefault
          )
        : [...current, nextRoleDefault]
    })
  }

  async function saveUser() {
    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
        setMessage(data.message || "Failed to save user.")
        return
      }

      setMessage("User saved.")
      setSelectedId(data.user.id)
      setDraft(userToDraft(data.user))
      await loadUsers(data.user.id)
    } catch {
      setMessage("Failed to save user.")
    } finally {
      setSaving(false)
    }
  }

  async function saveRoleDefault() {
    setSavingRoleDefault(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "save-role-default",
          roleDefault: {
            role: selectedRole,
            permissions: roleDefaultPermissions,
          },
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        setMessage(data.message || "Failed to save role defaults.")
        return
      }

      setMessage(`${selectedRole} defaults saved.`)
      setRoleDefaults((current) => {
        const next = data.roleDefault as ManagedAdminRoleDefault
        const exists = current.some((roleDefault) => roleDefault.role === next.role)
        return exists
          ? current.map((roleDefault) => (roleDefault.role === next.role ? next : roleDefault))
          : [...current, next]
      })
    } catch {
      setMessage("Failed to save role defaults.")
    } finally {
      setSavingRoleDefault(false)
    }
  }

  async function deleteUser() {
    if (!draft.id || !selectedUser) return

    const confirmed = window.confirm(`Delete ${selectedUser.username}?`)
    if (!confirmed) return

    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "delete",
          id: draft.id,
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        setMessage(data.message || "Failed to delete user.")
        return
      }

      setMessage("User deleted.")
      setSelectedId(null)
      setDraft(createDraftUser())
      await loadUsers(null)
    } catch {
      setMessage("Failed to delete user.")
    } finally {
      setSaving(false)
    }
  }

  if (authLoading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={pageStyle}>
        <button type="button" onClick={() => router.push("/admin")} className="fc-admin-nav-button" style={buttonStyle}>
          Go To Admin
        </button>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: "grid", gap: "14px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: "24px", color: "var(--fc-admin-heading)" }}>
              User Management
            </h1>
            <p style={{ margin: "5px 0 0", color: "var(--fc-admin-muted)", fontSize: "13px" }}>
              Create accounts and assign view or edit access by admin page.
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button type="button" onClick={() => router.push("/admin")} className="fc-admin-nav-button" style={buttonStyle}>
              Back
            </button>
          </div>
        </div>

        {message ? (
          <div
            style={{
              border: "1px solid var(--fc-admin-border)",
              borderRadius: "12px",
              background: "var(--fc-admin-panel-bg)",
              color: message.includes("Failed") || message.includes("required")
                ? "var(--fc-error)"
                : "var(--fc-success)",
              padding: "10px 12px",
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
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: "14px",
            alignItems: "start",
          }}
        >
          <div style={panelStyle}>
            <div style={sectionHeaderStyle}>
              <strong style={{ color: "var(--fc-admin-heading)", fontSize: "13px" }}>
                Users
              </strong>
              <button type="button" onClick={startNewUser} disabled={!canEdit} style={buttonStyle}>
                New
              </button>
            </div>
            <div style={{ display: "grid", gap: "8px", padding: "10px" }}>
              {users.map((user) => {
                const active = user.id === selectedId
                return (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => selectUser(user)}
                    style={{
                      border: active
                        ? "1px solid var(--fc-admin-selected-border)"
                        : "1px solid var(--fc-admin-border-soft)",
                      borderRadius: "12px",
                      background: active
                        ? "var(--fc-admin-selected-bg)"
                        : "var(--fc-admin-panel-soft-bg)",
                      color: active
                        ? "var(--fc-admin-selected-text)"
                        : "var(--fc-admin-panel-text)",
                      padding: "10px",
                      textAlign: "left",
                      cursor: "pointer",
                      boxShadow: "none",
                    }}
                  >
                    <div style={{ fontSize: "13px", fontWeight: 900 }}>{user.displayName}</div>
                    <div style={{ marginTop: "3px", color: "var(--fc-admin-muted)", fontSize: "12px" }}>
                      {user.username} · {user.role}
                    </div>
                  </button>
                )
              })}

              {users.length === 0 ? (
                <div style={{ color: "var(--fc-admin-muted)", fontSize: "13px", padding: "8px" }}>
                  No database users yet.
                </div>
              ) : null}
            </div>
          </div>

          <div style={panelStyle}>
            <div style={sectionHeaderStyle}>
              <strong style={{ color: "var(--fc-admin-heading)", fontSize: "13px" }}>
                Account
              </strong>
              <span style={{ color: "var(--fc-admin-muted)", fontSize: "12px", fontWeight: 800 }}>
                {draft.id ? "Existing" : "New"}
              </span>
            </div>
            <div style={{ display: "grid", gap: "14px", padding: "12px" }}>
              <label style={labelStyle}>
                Username
                <input
                  value={draft.username}
                  onChange={(event) => updateDraft("username", event.target.value)}
                  disabled={!canEdit}
                  style={inputStyle}
                />
              </label>

              <label style={labelStyle}>
                Display Name
                <input
                  value={draft.displayName}
                  onChange={(event) => updateDraft("displayName", event.target.value)}
                  disabled={!canEdit}
                  style={inputStyle}
                />
              </label>

              <label style={labelStyle}>
                Password
                <input
                  value={draft.password}
                  type="password"
                  placeholder={draft.id ? "Leave blank to keep password" : "Required"}
                  onChange={(event) => updateDraft("password", event.target.value)}
                  disabled={!canEdit}
                  style={inputStyle}
                />
              </label>

              <label style={labelStyle}>
                Role
                <select
                  value={draft.role}
                  onChange={(event) => updateDraftRole(normaliseAdminRole(event.target.value))}
                  disabled={!canEdit}
                  style={inputStyle}
                >
                  {ADMIN_ROLE_IDS.map((roleId) => (
                    <option key={roleId} value={roleId}>
                      {roleId}
                    </option>
                  ))}
                </select>
              </label>

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {ADMIN_ROLE_IDS.map((roleId) => (
                  <button
                    key={roleId}
                    type="button"
                    onClick={() => updateDraftRole(roleId)}
                    disabled={!canEdit}
                    style={{
                      ...buttonStyle,
                      minHeight: "30px",
                      background:
                        draft.role === roleId
                          ? "var(--fc-admin-selected-bg)"
                          : buttonStyle.background,
                      color:
                        draft.role === roleId
                          ? "var(--fc-admin-selected-text)"
                          : buttonStyle.color,
                      borderColor:
                        draft.role === roleId
                          ? "var(--fc-admin-selected-border)"
                          : "var(--fc-admin-button-border)",
                    }}
                  >
                    {roleId}
                  </button>
                ))}
              </div>

              {selectedUser ? (
                <div
                  style={{
                    border: "1px solid var(--fc-admin-border-soft)",
                    borderRadius: "12px",
                    background: "var(--fc-admin-panel-soft-bg)",
                    padding: "10px",
                    color: "var(--fc-admin-muted)",
                    fontSize: "12px",
                    lineHeight: 1.5,
                  }}
                >
                  Last updated {formatDate(selectedUser.updatedAt)}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={saveUser}
                  disabled={!canEdit || saving}
                  style={primaryButtonStyle}
                >
                  {saving ? "Saving..." : "Save User"}
                </button>
                <button
                  type="button"
                  onClick={deleteUser}
                  disabled={!canEdit || saving || !draft.id || draft.username === username}
                  style={dangerButtonStyle}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>

          <div style={panelStyle}>
            <div style={sectionHeaderStyle}>
              <strong style={{ color: "var(--fc-admin-heading)", fontSize: "13px" }}>
                Role Defaults
              </strong>
              <span style={{ color: "var(--fc-admin-muted)", fontSize: "12px", fontWeight: 800 }}>
                {selectedRoleIsAdmin ? "Full Access" : `${selectedRole} Defaults`}
              </span>
            </div>
            <div style={{ display: "grid", gap: "14px", padding: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {ADMIN_ROLE_IDS.map((roleId) => (
                    <button
                      key={roleId}
                      type="button"
                      onClick={() => setSelectedRole(roleId)}
                      style={{
                        ...buttonStyle,
                        background:
                          selectedRole === roleId
                            ? "var(--fc-admin-selected-bg)"
                            : buttonStyle.background,
                        color:
                          selectedRole === roleId
                            ? "var(--fc-admin-selected-text)"
                            : buttonStyle.color,
                        borderColor:
                          selectedRole === roleId
                            ? "var(--fc-admin-selected-border)"
                            : "var(--fc-admin-button-border)",
                      }}
                    >
                      {roleId}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={saveRoleDefault}
                  disabled={!canEdit || savingRoleDefault || selectedRoleIsAdmin}
                  style={primaryButtonStyle}
                >
                  {savingRoleDefault ? "Saving..." : "Save Defaults"}
                </button>
              </div>

              {Object.entries(groupedPages).map(([group, groupPages]) => (
                <div key={group}>
                  <div
                    style={{
                      marginBottom: "8px",
                      color: "var(--fc-admin-heading)",
                      fontSize: "12px",
                      fontWeight: 900,
                      textTransform: "uppercase",
                    }}
                  >
                    {ADMIN_PAGE_GROUP_LABELS[group as keyof typeof ADMIN_PAGE_GROUP_LABELS]}
                  </div>

                  <div style={{ display: "grid", gap: "8px" }}>
                    {groupPages.map((page) => {
                      const permission = roleDefaultPermissions[page.id] || (selectedRoleIsAdmin ? "edit" : "view")

                      return (
                        <div
                          key={page.id}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(150px, 1fr) auto",
                            gap: "10px",
                            alignItems: "center",
                            border: "1px solid var(--fc-admin-border-soft)",
                            borderRadius: "12px",
                            background: "var(--fc-admin-panel-soft-bg)",
                            padding: "9px 10px",
                          }}
                        >
                          <div>
                            <div style={{ fontSize: "13px", fontWeight: 900 }}>{page.label}</div>
                            <div style={{ marginTop: "3px", color: "var(--fc-admin-muted)", fontSize: "11px" }}>
                              {getPermissionLabel(permission)}
                            </div>
                          </div>

                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(3, 58px)",
                              gap: "5px",
                            }}
                          >
                            {(["none", "view", "edit"] as AdminPagePermission[]).map((option) => {
                              const active = permission === option
                              return (
                                <button
                                  key={option}
                                  type="button"
                                  onClick={() => updateRolePermission(page.id, option)}
                                  disabled={!canEdit || selectedRoleIsAdmin}
                                  style={{
                                    minHeight: "30px",
                                    border: active
                                      ? "1px solid var(--fc-admin-selected-border)"
                                      : "1px solid var(--fc-admin-border)",
                                    borderRadius: "999px",
                                    background: active
                                      ? "var(--fc-admin-selected-bg)"
                                      : "var(--fc-admin-button-bg)",
                                    color: active
                                      ? "var(--fc-admin-selected-text)"
                                      : "var(--fc-admin-button-text)",
                                    cursor: canEdit && !selectedRoleIsAdmin ? "pointer" : "not-allowed",
                                    fontSize: "11px",
                                    fontWeight: 900,
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
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
