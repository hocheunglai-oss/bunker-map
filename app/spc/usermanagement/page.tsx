"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { useSpcAuth } from "@/lib/useSpcAuth"
import type { SpcRoleId } from "@/lib/spcUsers"

type ManagedSpcUser = {
  id: string
  username: string
  displayName: string
  role: SpcRoleId
  roleLabel: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

type SpcRoleDefinition = {
  id: SpcRoleId
  label: string
  description: string
}

type UsersResponse = {
  users?: ManagedSpcUser[]
  roles?: SpcRoleDefinition[]
  message?: string
}

type DraftUser = {
  id?: string
  username: string
  displayName: string
  role: SpcRoleId
  password: string
  isActive: boolean
}

const defaultRoles: SpcRoleDefinition[] = [
  {
    id: "buyer_trader",
    label: "Buyer Trader",
    description: "Create enquiries, review history, and manage SPC users.",
  },
  {
    id: "supplier_trader",
    label: "Supplier Trader",
    description: "Use the SPC WhatsApp workspace.",
  },
]

function createDraft(role: SpcRoleId): DraftUser {
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
  const { loading: authLoading, authenticated, role, username } = useSpcAuth()
  const [users, setUsers] = useState<ManagedSpcUser[]>([])
  const [roles, setRoles] = useState<SpcRoleDefinition[]>(defaultRoles)
  const [selectedRole, setSelectedRole] = useState<SpcRoleId>("buyer_trader")
  const [draft, setDraft] = useState<DraftUser>(() => createDraft("buyer_trader"))
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [messageIsError, setMessageIsError] = useState(false)

  const selectedRoleUsers = useMemo(
    () => users.filter((user) => user.role === selectedRole),
    [selectedRole, users],
  )
  const selectedRoleDefinition = roles.find((item) => item.id === selectedRole) || roles[0]

  const loadUsers = useCallback(async () => {
    if (!authenticated || role !== "buyer_trader") return
    setLoading(true)
    try {
      const response = await fetch("/api/spc/users", { cache: "no-store" })
      const data = (await response.json()) as UsersResponse
      if (!response.ok) throw new Error(data.message || "Failed to load SPC users.")
      setUsers(data.users || [])
      setRoles(data.roles || defaultRoles)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load SPC users.")
      setMessageIsError(true)
    } finally {
      setLoading(false)
    }
  }, [authenticated, role])

  useEffect(() => {
    document.title = "SPC User Management"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || role !== "buyer_trader")) router.replace("/spc")
  }, [authLoading, authenticated, role, router])

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
      setUsers((current) => {
        const exists = current.some((user) => user.id === data.user!.id)
        return exists
          ? current.map((user) => (user.id === data.user!.id ? data.user! : user))
          : [...current, data.user!].sort((a, b) => a.username.localeCompare(b.username))
      })
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
      setUsers((current) => current.filter((item) => item.id !== user.id))
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

  if (authLoading || !authenticated || role !== "buyer_trader") {
    return <div className="spc-loading">Loading...</div>
  }

  return (
    <SpcShell title="SPC User Management">
      <div className="spc-page-heading">
        <div>
          <h1>User Management</h1>
          <p>{users.length} SPC users</p>
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
            {roles.map((item) => {
              const count = users.filter((user) => user.role === item.id).length
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectRole(item.id)}
                  className={selectedRole === item.id ? "is-active" : ""}
                >
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  <em>{count}</em>
                </button>
              )
            })}
          </div>
        </section>

        <section className="spc-panel">
          <div className="spc-panel-header">
            <div>
              <h2>{selectedRoleDefinition?.label || "SPC Users"}</h2>
            </div>
            <button type="button" onClick={() => setDraft(createDraft(selectedRole))}>
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
                  disabled={saving || user.username === username}
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
              />
            </label>
            <label>
              <span>Display Name</span>
              <input
                value={draft.displayName}
                onChange={(event) => updateDraft("displayName", event.target.value)}
              />
            </label>
            <label>
              <span>Group</span>
              <select
                value={draft.role}
                onChange={(event) => updateDraft("role", event.target.value as SpcRoleId)}
              >
                {roles.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
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
              />
            </label>
            <label className="spc-checkbox-field">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(event) => updateDraft("isActive", event.target.checked)}
              />
              <span>Active account</span>
            </label>
            <div className="spc-form-actions">
              <button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save User"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </SpcShell>
  )
}
