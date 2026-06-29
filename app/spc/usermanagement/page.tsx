"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import {
  canAccessSpcPage,
  normaliseSpcPagePermissions,
  normaliseSpcRole,
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
  pages?: SpcPageDefinition[]
  roleDefaults?: ManagedSpcRoleDefault[]
  groupStorage?: string
  message?: string
}

type DraftUser = {
  id?: string
  username: string
  displayName: string
  role: string
  password: string
  isActive: boolean
}

function createDraft(role = "BUYER TRADER"): DraftUser {
  return {
    username: "",
    displayName: "",
    role,
    password: "",
    isActive: true,
  }
}

function userToDraft(user: ManagedSpcUser): DraftUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    password: "",
    isActive: user.isActive,
  }
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value))
}

export default function SpcUserManagementPage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions, username } = useSpcAuth()
  const [users, setUsers] = useState<ManagedSpcUser[]>([])
  const [pages, setPages] = useState<SpcPageDefinition[]>([])
  const [roleDefaults, setRoleDefaults] = useState<ManagedSpcRoleDefault[]>([])
  const [selectedRole, setSelectedRole] = useState<SpcRoleId>("BUYER TRADER")
  const [draft, setDraft] = useState<DraftUser>(() => createDraft("BUYER TRADER"))
  const [newGroupName, setNewGroupName] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const canView = canAccessSpcPage(permissions, "spc-user-management", "view")
  const canEdit = canAccessSpcPage(permissions, "spc-user-management", "edit")
  const selectedRoleUsers = useMemo(
    () => users.filter((user) => user.role === selectedRole),
    [selectedRole, users],
  )
  const selectedGroup = roleDefaults.find((item) => item.role === selectedRole) || roleDefaults[0] || null
  const selectedPermissions = selectedGroup
    ? normaliseSpcPagePermissions(selectedGroup.permissions, "view", pages)
    : normaliseSpcPagePermissions(null, "view", pages)

  const loadUsers = useCallback(async () => {
    if (!authenticated || !canView) return

    setLoading(true)
    try {
      const response = await fetch("/api/spc/users", { cache: "no-store" })
      const data = (await response.json()) as UsersResponse
      if (!response.ok) throw new Error(data.message || "Failed to load SPC users.")

      const nextGroups = data.roleDefaults || []
      setUsers(data.users || [])
      setPages(data.pages || [])
      setRoleDefaults(nextGroups)
      setSelectedRole((current) =>
        nextGroups.some((group) => group.role === current)
          ? current
          : nextGroups.find((group) => group.role === "BUYER TRADER")?.role || nextGroups[0]?.role || "BUYER TRADER",
      )
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

  function selectRole(nextRole: SpcRoleId) {
    setSelectedRole(nextRole)
    setDraft(createDraft(nextRole))
    setMessage("")
  }

  function editUser(user: ManagedSpcUser) {
    setSelectedRole(user.role)
    setDraft(userToDraft(user))
    setMessage("")
  }

  function updateDraft<K extends keyof DraftUser>(key: K, value: DraftUser[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  function updateRolePermission(pageId: string, permission: SpcPagePermission) {
    if (!selectedGroup || !canEdit) return
    setRoleDefaults((current) =>
      current.map((group) =>
        group.role === selectedGroup.role
          ? {
              ...group,
              permissions: {
                ...normaliseSpcPagePermissions(group.permissions, "view", pages),
                [pageId]: permission,
              },
            }
          : group,
      ),
    )
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", user: draft }),
      })
      const data = (await response.json()) as { user?: ManagedSpcUser; message?: string }
      if (!response.ok || !data.user) throw new Error(data.message || "Failed to save SPC user.")
      await loadUsers()
      setSelectedRole(data.user.role)
      setDraft(createDraft(data.user.role))
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
    if (!window.confirm(`Delete ${user.displayName || user.username}?`)) return
    setSaving(true)
    setMessage("")

    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: user.id }),
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to delete SPC user.")
      await loadUsers()
      if (draft.id === user.id) setDraft(createDraft(selectedRole))
      setMessage("User deleted.")
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete SPC user.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function saveRoleDefault() {
    if (!selectedGroup) return

    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/users", {
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
      const data = (await response.json()) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to save permission group.")
      await loadUsers()
      setMessage(`${selectedGroup.role} permissions saved.`)
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save permission group.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function createGroup() {
    const requestedName = newGroupName.trim()
    if (!requestedName) {
      setMessage("Group name is required.")
      setMessageIsError(true)
      return
    }

    const nextRole = normaliseSpcRole(requestedName)
    if (roleDefaults.some((group) => group.role === nextRole)) {
      setMessage(`${nextRole} already exists.`)
      setMessageIsError(true)
      return
    }

    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-role-default",
          roleDefault: {
            role: requestedName,
            permissions: normaliseSpcPagePermissions(null, "view", pages),
          },
        }),
      })
      const data = (await response.json()) as { roleDefault?: ManagedSpcRoleDefault; message?: string }
      if (!response.ok || !data.roleDefault) throw new Error(data.message || "Failed to create permission group.")
      setNewGroupName("")
      setSelectedRole(data.roleDefault.role)
      await loadUsers()
      setMessage(`${data.roleDefault.role} group created.`)
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to create permission group.")
      setMessageIsError(true)
    } finally {
      setSaving(false)
    }
  }

  async function deleteGroup() {
    if (!selectedGroup || selectedGroup.isBuiltIn) return
    if (!window.confirm(`Delete the ${selectedGroup.role} permission group?`)) return

    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/spc/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete-role-default",
          roleDefault: { role: selectedGroup.role },
        }),
      })
      const data = (await response.json().catch(() => ({}))) as { message?: string }
      if (!response.ok) throw new Error(data.message || "Failed to delete permission group.")
      setSelectedRole("BUYER TRADER")
      await loadUsers()
      setMessage(`${selectedGroup.role} group deleted.`)
      setMessageIsError(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete permission group.")
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
      <div className="spc-page-heading">
        <div>
          <h1>User Management</h1>
          <p>{users.length} SPC users · {roleDefaults.length} groups</p>
        </div>
      </div>

      {message ? (
        <div className={messageIsError ? "spc-alert is-error" : "spc-alert"}>
          {message}
        </div>
      ) : null}

      <div className="spc-user-grid">
        <section className="spc-panel">
          <div className="spc-group-list">
            {roleDefaults.map((item) => (
              <button
                key={item.role}
                type="button"
                onClick={() => selectRole(item.role)}
                className={selectedRole === item.role ? "is-active" : ""}
              >
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.isBuiltIn ? "Built-in SPC group" : "Custom SPC group"}</small>
                </span>
                <em>{item.memberCount}</em>
              </button>
            ))}
            {canEdit ? (
              <div className="spc-group-create">
                <input
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  placeholder="New group name"
                />
                <button type="button" onClick={() => void createGroup()} disabled={saving}>
                  Add Group
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="spc-panel">
          <div className="spc-panel-header">
            <div>
              <h2>{selectedGroup?.label || "SPC Users"}</h2>
            </div>
            <button type="button" onClick={() => setDraft(createDraft(selectedRole))} disabled={!canEdit}>
              New User
            </button>
          </div>

          <div className="spc-user-list">
            {selectedRoleUsers.map((user) => (
              <article key={user.id} className={!user.isActive ? "is-disabled" : ""}>
                <button type="button" onClick={() => editUser(user)}>
                  <strong>{user.displayName}</strong>
                  <span>{user.username}</span>
                  <small>{user.isActive ? "Active" : "Inactive"} · {displayDate(user.updatedAt)}</small>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteUser(user)}
                  disabled={saving || !canEdit || (user.username === username && user.username !== "spcadmin")}
                  aria-label={`Delete ${user.displayName}`}
                  title={`Delete ${user.displayName}`}
                >
                  Delete
                </button>
              </article>
            ))}
            {!loading && selectedRoleUsers.length === 0 ? (
              <p className="spc-empty">No users in this group.</p>
            ) : null}
          </div>
        </section>

        <section className="spc-panel">
          <div className="spc-panel-header">
            <h2>{draft.id ? "Edit User" : "New User"}</h2>
          </div>
          <form onSubmit={saveUser} className="spc-user-form">
            <label>
              <span>Username</span>
              <input
                value={draft.username}
                onChange={(event) => updateDraft("username", event.target.value)}
                autoComplete="username"
                required
                disabled={!canEdit}
              />
            </label>
            <label>
              <span>Display Name</span>
              <input
                value={draft.displayName}
                onChange={(event) => updateDraft("displayName", event.target.value)}
                disabled={!canEdit}
              />
            </label>
            <label>
              <span>Group</span>
              <select
                value={draft.role}
                onChange={(event) => updateDraft("role", event.target.value)}
                disabled={!canEdit}
              >
                {roleDefaults.map((item) => (
                  <option key={item.role} value={item.role}>{item.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{draft.id ? "New Password" : "Password"}</span>
              <input
                type="password"
                value={draft.password}
                onChange={(event) => updateDraft("password", event.target.value)}
                autoComplete="new-password"
                required={!draft.id}
                disabled={!canEdit}
              />
            </label>
            <label className="spc-checkbox-field">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(event) => updateDraft("isActive", event.target.checked)}
                disabled={!canEdit}
              />
              <span>Active account</span>
            </label>
            <div className="spc-form-actions">
              <button type="submit" disabled={saving || !canEdit}>
                {saving ? "Saving..." : "Save User"}
              </button>
            </div>
          </form>
        </section>

        <section className="spc-panel spc-authority-panel">
          <div className="spc-panel-header">
            <h2>Authority</h2>
            <div className="spc-authority-actions">
              <button type="button" onClick={() => void saveRoleDefault()} disabled={!canEdit || saving || !selectedGroup}>
                Save Authority
              </button>
              {selectedGroup && !selectedGroup.isBuiltIn ? (
                <button type="button" onClick={() => void deleteGroup()} disabled={!canEdit || saving}>
                  Delete Group
                </button>
              ) : null}
            </div>
          </div>
          <div className="spc-authority-list">
            {pages.map((page) => (
              <label key={page.id}>
                <span>
                  <strong>{page.label}</strong>
                  <small>{page.group.replace("-", " ")}</small>
                </span>
                <select
                  value={selectedPermissions[page.id] || "none"}
                  onChange={(event) => updateRolePermission(page.id, event.target.value as SpcPagePermission)}
                  disabled={!canEdit}
                >
                  <option value="none">None</option>
                  <option value="view">View</option>
                  <option value="edit">Edit</option>
                </select>
              </label>
            ))}
          </div>
        </section>
      </div>
    </SpcShell>
  )
}
