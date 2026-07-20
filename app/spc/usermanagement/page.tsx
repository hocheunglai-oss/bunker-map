"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import {
  canAccessSpcPage,
  normaliseSpcPagePermissions,
  type SpcPageDefinition,
  type SpcPagePermission,
  type SpcPagePermissionMap,
  type SpcRoleId,
} from "@/lib/spcPages"

type ManagedSpcUser = {
  id: string
  username: string
  displayName: string
  role: SpcRoleId
  roleLabel: string
  office: string
  mustChangePassword: boolean
  permissions: SpcPagePermissionMap
  isActive: boolean
  createdAt: string
  updatedAt: string
}

type ManagedSpcRoleDefault = {
  role: SpcRoleId
  label: string
  permissions: SpcPagePermissionMap
  updatedAt: string | null
  memberCount: number
  persisted: boolean
  isBuiltIn: boolean
}

type UsersResponse = {
  users?: ManagedSpcUser[]
  offices?: string[]
  pages?: SpcPageDefinition[]
  roleDefaults?: ManagedSpcRoleDefault[]
  message?: string
}

type UserTab = "SUPPLIER TRADER" | "BUYER TRADER" | "ADMIN" | "OFFICE"

type UserDraft = {
  id?: string
  username: string
  displayName: string
  role: Exclude<UserTab, "OFFICE">
  office: string
  password: string
  mustChangePassword: boolean
  isActive: boolean
}

const USER_TABS: Array<{ id: UserTab; label: string }> = [
  { id: "SUPPLIER TRADER", label: "SUPPLIER TRADER" },
  { id: "BUYER TRADER", label: "BUYER TRADER" },
  { id: "ADMIN", label: "ADMIN" },
  { id: "OFFICE", label: "OFFICE" },
]

const USER_ROLE_OPTIONS = USER_TABS.filter(
  (tab): tab is { id: Exclude<UserTab, "OFFICE">; label: string } => tab.id !== "OFFICE",
)
const DEFAULT_PASSWORD = "Since1857"
const DEFAULT_OFFICES = ["ITALY", "HONG KONG", "SINGAPORE", "MONACO", "FRANCE", "USA", "KOREA", "JAPAN", "VIETNAM"]

function cleanOffice(value: string) {
  return value.trim().replace(/\s+/g, " ").toUpperCase()
}

function roleLabel(role: string) {
  return USER_TABS.find((tab) => tab.id === role)?.label || role
}

function createDraft(role: Exclude<UserTab, "OFFICE">, office: string): UserDraft {
  return {
    username: "",
    displayName: "",
    role,
    office,
    password: DEFAULT_PASSWORD,
    mustChangePassword: true,
    isActive: true,
  }
}

function userToDraft(user: ManagedSpcUser, fallbackOffice: string): UserDraft {
  const role = USER_ROLE_OPTIONS.some((option) => option.id === user.role)
    ? (user.role as Exclude<UserTab, "OFFICE">)
    : "BUYER TRADER"

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role,
    office: user.office || fallbackOffice,
    password: "",
    mustChangePassword: user.mustChangePassword,
    isActive: user.isActive,
  }
}

export default function SpcUserManagementPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, username } = useSpcAuth()
  const [users, setUsers] = useState<ManagedSpcUser[]>([])
  const [offices, setOffices] = useState<string[]>(DEFAULT_OFFICES)
  const [pages, setPages] = useState<SpcPageDefinition[]>([])
  const [roleDefaults, setRoleDefaults] = useState<ManagedSpcRoleDefault[]>([])
  const [activeTab, setActiveTab] = useState<UserTab>("SUPPLIER TRADER")
  const [userDraft, setUserDraft] = useState<UserDraft | null>(null)
  const [selectedOffice, setSelectedOffice] = useState("")
  const [officeDialogOpen, setOfficeDialogOpen] = useState(false)
  const [officeDraft, setOfficeDraft] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canView = canAccessSpcPage(permissions, "spc-user-management", "view")
  const canEdit = canAccessSpcPage(permissions, "spc-user-management", "edit")
  const firstOffice = offices[0] || DEFAULT_OFFICES[0]
  const activeUsers = useMemo(
    () => users.filter((user) => user.role === activeTab),
    [activeTab, users],
  )
  const usersByOffice = useMemo(() => {
    return users.reduce<Record<string, number>>((map, user) => {
      const office = cleanOffice(user.office || firstOffice)
      map[office] = (map[office] || 0) + 1
      return map
    }, {})
  }, [firstOffice, users])
  const activeOffice = offices.includes(selectedOffice) ? selectedOffice : firstOffice
  const officeUsers = useMemo(() => {
    return users
      .filter((user) => cleanOffice(user.office || firstOffice) === activeOffice)
      .sort((a, b) => {
        const roleOrder = a.role.localeCompare(b.role)
        if (roleOrder !== 0) return roleOrder
        return (a.displayName || a.username).localeCompare(b.displayName || b.username)
      })
  }, [activeOffice, firstOffice, users])
  const roleCounts = useMemo(() => {
    return users.reduce<Record<string, number>>((map, user) => {
      map[user.role] = (map[user.role] || 0) + 1
      return map
    }, {})
  }, [users])
  const selectedRoleDefault = useMemo(() => {
    if (activeTab === "OFFICE") return null
    return roleDefaults.find((roleDefault) => roleDefault.role === activeTab) || null
  }, [activeTab, roleDefaults])
  const selectedRolePermissions = useMemo(() => {
    return normaliseSpcPagePermissions(selectedRoleDefault?.permissions, "none", pages)
  }, [pages, selectedRoleDefault])

  const loadUsers = useCallback(async () => {
    if (!authenticated || !canView) return

    setLoading(true)
    try {
      const response = await fetch("/api/spc/users", { cache: "no-store" })
      const data = (await response.json()) as UsersResponse
      if (!response.ok) throw new Error(data.message || "Failed to load SPC users.")

      setUsers(data.users || [])
      setOffices(data.offices?.length ? data.offices : DEFAULT_OFFICES)
      setPages(data.pages || [])
      setRoleDefaults(data.roleDefaults || [])
      setSelectedOffice((current) => {
        const nextOffices = data.offices?.length ? data.offices : DEFAULT_OFFICES
        return current && nextOffices.includes(current) ? current : nextOffices[0] || DEFAULT_OFFICES[0]
      })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load SPC users.")
      setMessageIsError(true)
    } finally {
      setLoading(false)
    }
  }, [authenticated, canView])

  useEffect(() => {
    document.title = "SPC User Management"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  function openAddDialog() {
    setMessage("")
    if (activeTab === "OFFICE") {
      setOfficeDraft("")
      setOfficeDialogOpen(true)
      return
    }
    setUserDraft(createDraft(activeTab, firstOffice))
  }

  function selectOffice(office: string) {
    setSelectedOffice(office)
    setMessage("")
  }

  function editUser(user: ManagedSpcUser) {
    setMessage("")
    setUserDraft(userToDraft(user, firstOffice))
  }

  function updateDraft<K extends keyof UserDraft>(key: K, value: UserDraft[K]) {
    setUserDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  function updateRolePermission(pageId: string, permission: SpcPagePermission) {
    if (activeTab === "OFFICE" || !selectedRoleDefault) return
    setRoleDefaults((current) =>
      current.map((roleDefault) =>
        roleDefault.role === activeTab
          ? {
              ...roleDefault,
              permissions: {
                ...normaliseSpcPagePermissions(roleDefault.permissions, "none", pages),
                [pageId]: permission,
              },
            }
          : roleDefault,
      ),
    )
  }

  async function saveRoleAuthority() {
    if (!canEdit || activeTab === "OFFICE" || !selectedRoleDefault) return

    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-role-default",
          roleDefault: {
            role: activeTab,
            permissions: selectedRolePermissions,
          },
        }),
      })
      const data = (await response.json()) as { roleDefault?: ManagedSpcRoleDefault; message?: string }
      if (!response.ok || !data.roleDefault) throw new Error(data.message || "Failed to save authority.")

      await loadUsers()
      setMessage("Authority saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save authority.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!userDraft || !canEdit) return

    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", user: userDraft }),
      })
      const data = (await response.json()) as { user?: ManagedSpcUser; message?: string }
      if (!response.ok || !data.user) throw new Error(data.message || "Failed to save SPC user.")

      await loadUsers()
      setActiveTab(data.user.role === "ADMIN" || data.user.role === "SUPPLIER TRADER" ? data.user.role : "BUYER TRADER")
      setUserDraft(null)
      setMessage("User saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save SPC user.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function deleteUser(user: ManagedSpcUser) {
    if (!canEdit) return
    if (!window.confirm(`Remove ${user.displayName || user.username}?`)) return

    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: user.id }),
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to remove SPC user.")

      await loadUsers()
      setMessage("User removed.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove SPC user.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function saveOffice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const office = cleanOffice(officeDraft)
    if (!office || !canEdit) return

    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-office", office }),
      })
      const data = (await response.json()) as { offices?: string[]; message?: string }
      if (!response.ok || !data.offices) throw new Error(data.message || "Failed to save office.")

      setOffices(data.offices)
      setOfficeDraft("")
      setOfficeDialogOpen(false)
      setMessage("Office saved.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save office.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function deleteOffice(office: string) {
    if (!canEdit) return
    const affectedUsers = usersByOffice[office] || 0
    const fallbackOffice =
      offices.find((item) => item !== office) ||
      DEFAULT_OFFICES.find((item) => item !== office) ||
      DEFAULT_OFFICES[0]
    const warning = affectedUsers
      ? `Remove ${office}? ${affectedUsers} user${affectedUsers === 1 ? "" : "s"} will be moved to ${fallbackOffice}.`
      : `Remove ${office}?`
    if (!window.confirm(warning)) return

    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-office", office }),
      })
      const data = (await response.json()) as { offices?: string[]; message?: string }
      if (!response.ok || !data.offices) throw new Error(data.message || "Failed to remove office.")

      setOffices(data.offices.length ? data.offices : DEFAULT_OFFICES)
      setMessage("Office removed.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove office.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC User Management">
      {message ? (
        <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>
          {message}
        </div>
      ) : null}

      <div className="spc-user-compact">
        <section className="spc-panel spc-user-directory" aria-label="SPC users and offices">
          <div className="spc-user-tabs" role="tablist" aria-label="SPC user categories">
            {USER_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? "is-active" : ""}
                onClick={() => {
                  setActiveTab(tab.id)
                  setMessage("")
                }}
              >
                <span>{tab.label}</span>
                <em>{loading ? "…" : tab.id === "OFFICE" ? offices.length : roleCounts[tab.id] || 0}</em>
              </button>
            ))}
          </div>

          <div className="spc-user-directory-toolbar">
            <button type="button" onClick={openAddDialog} disabled={!canEdit}>
              Add
            </button>
          </div>

          <div className="spc-compact-list">
            {activeTab === "OFFICE"
              ? offices.map((office) => (
                  <article
                    key={office}
                    className={office === activeOffice ? "spc-compact-row spc-office-row is-active" : "spc-compact-row spc-office-row"}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectOffice(office)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        selectOffice(office)
                      }
                    }}
                  >
                    <span>
                      <strong>{office}</strong>
                      <small>{usersByOffice[office] || 0} users</small>
                    </span>
                    <div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          void deleteOffice(office)
                        }}
                        disabled={!canEdit || saving}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))
              : activeUsers.map((user) => (
                  <article key={user.id} className={user.isActive ? "spc-compact-row" : "spc-compact-row is-disabled"}>
                    <span>
                      <strong>{user.displayName || user.username}</strong>
                      <small>{user.username} · {user.office || firstOffice}</small>
                    </span>
                    <div>
                      <button type="button" onClick={() => editUser(user)} disabled={!canEdit}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => void deleteUser(user)}
                        disabled={saving || !canEdit || user.username === username}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
            {!loading && activeTab !== "OFFICE" && activeUsers.length === 0 ? (
              <p className="spc-empty">No {roleLabel(activeTab).toLowerCase()} users.</p>
            ) : null}
          </div>
        </section>

        <section className="spc-panel spc-user-authority" aria-label="SPC user authority">
          <div className="spc-panel-header">
            <h2>{activeTab === "OFFICE" ? "USERS" : "AUTHORITY"}</h2>
            {activeTab === "OFFICE" ? null : (
              <button
                type="button"
                className="spc-authority-save"
                onClick={() => void saveRoleAuthority()}
                disabled={!canEdit || saving || !selectedRoleDefault}
              >
                SAVE
              </button>
            )}
          </div>
          {activeTab === "OFFICE" ? (
            <div className="spc-office-users">
              <div className="spc-office-users-summary">
                <strong>{activeOffice}</strong>
                <span>{loading ? "LOADING USERS..." : `${officeUsers.length} USER${officeUsers.length === 1 ? "" : "S"}`}</span>
              </div>
              {loading ? (
                <p className="spc-empty">Loading users...</p>
              ) : officeUsers.length ? (
                <div className="spc-authority-list">
                  {officeUsers.map((user) => (
                    <article key={user.id} className={user.isActive ? "spc-authority-row" : "spc-authority-row is-disabled"}>
                      <span>
                        <strong>{user.displayName || user.username}</strong>
                        <small>{user.roleLabel || roleLabel(user.role)} · {user.username}</small>
                      </span>
                      <div>
                        <button
                          type="button"
                          className="spc-office-user-edit"
                          onClick={() => editUser(user)}
                          disabled={!canEdit}
                        >
                          EDIT
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="spc-empty">No users in this office.</p>
              )}
            </div>
          ) : pages.length ? (
            <div className="spc-authority-list">
              {pages.map((page) => (
                <article key={page.id} className="spc-authority-row">
                  <span>
                    <strong>{page.label}</strong>
                    <small>{page.group}</small>
                  </span>
                  <div className="spc-authority-toggle" role="group" aria-label={`${page.label} authority`}>
                    {(["none", "view", "edit"] as SpcPagePermission[]).map((permission) => (
                      <button
                        key={permission}
                        type="button"
                        className={selectedRolePermissions[page.id] === permission ? "is-active" : ""}
                        onClick={() => updateRolePermission(page.id, permission)}
                        disabled={!canEdit || saving}
                      >
                        {permission.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="spc-empty">{loading ? "Loading authority settings..." : "No authority settings configured."}</p>
          )}
        </section>
      </div>

      {officeDialogOpen ? (
        <div className="spc-dialog-backdrop" role="presentation">
          <form className="spc-dialog spc-user-dialog" role="dialog" aria-modal="true" onSubmit={saveOffice}>
            <div className="spc-dialog-header">
              <h2>Add Office</h2>
              <button type="button" onClick={() => setOfficeDialogOpen(false)}>×</button>
            </div>
            <label className="spc-dialog-field">
              <span>Office</span>
              <input
                value={officeDraft}
                onChange={(event) => setOfficeDraft(event.target.value)}
                autoFocus
                required
              />
            </label>
            <div className="spc-dialog-actions">
              <button type="button" onClick={() => setOfficeDialogOpen(false)}>Cancel</button>
              <button type="submit" className="is-primary" disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {userDraft ? (
        <div className="spc-dialog-backdrop" role="presentation">
          <form className="spc-dialog spc-user-dialog" role="dialog" aria-modal="true" onSubmit={saveUser}>
            <div className="spc-dialog-header">
              <h2>{userDraft.id ? "Edit User" : "Add User"}</h2>
              <button type="button" onClick={() => setUserDraft(null)}>×</button>
            </div>
            <div className="spc-user-dialog-fields">
              <label>
                <span>Username</span>
                <input
                  value={userDraft.username}
                  onChange={(event) => updateDraft("username", event.target.value)}
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                <span>Display Name</span>
                <input
                  value={userDraft.displayName}
                  onChange={(event) => updateDraft("displayName", event.target.value)}
                />
              </label>
              <label>
                <span>Role</span>
                <select
                  value={userDraft.role}
                  onChange={(event) =>
                    updateDraft("role", event.target.value as Exclude<UserTab, "OFFICE">)
                  }
                >
                  {USER_ROLE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Office</span>
                <select value={userDraft.office} onChange={(event) => updateDraft("office", event.target.value)}>
                  {offices.map((office) => (
                    <option key={office} value={office}>{office}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{userDraft.id ? "New Password" : "Password"}</span>
                <input
                  type="password"
                  value={userDraft.password}
                  onChange={(event) => updateDraft("password", event.target.value)}
                  autoComplete="new-password"
                  required={!userDraft.id}
                />
              </label>
              <label className="spc-checkbox-field">
                <input
                  type="checkbox"
                  checked={userDraft.mustChangePassword}
                  onChange={(event) => updateDraft("mustChangePassword", event.target.checked)}
                />
                <span>Change password on next login</span>
              </label>
              <label className="spc-checkbox-field">
                <input
                  type="checkbox"
                  checked={userDraft.isActive}
                  onChange={(event) => updateDraft("isActive", event.target.checked)}
                />
                <span>Active account</span>
              </label>
            </div>
            <div className="spc-dialog-actions">
              <button type="button" onClick={() => setUserDraft(null)}>Cancel</button>
              <button type="submit" className="is-primary" disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </SpcShell>
  )
}
