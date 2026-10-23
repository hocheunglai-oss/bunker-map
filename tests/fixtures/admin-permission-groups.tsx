import React from "react"
import { createRoot } from "react-dom/client"
import Page from "../../app/admin/usermanagement/page"
import { AdminNavigationShell } from "../../components/AdminNavigationShell"
import { ADMIN_PAGE_DEFINITIONS } from "../../lib/adminPages"

const policy = { "user-management": "view", "attendance-record": "view" }
const groups = ["ADMIN", "AC", "BT", "VN", "CUSTOM GROUP"].map((role, index) => ({ role, permissions: { ...policy },
  updatedAt: "2026-10-22T01:00:00Z", memberCount: role === "BT" ? 1 : 0, hasMixedPermissions: false,
  persisted: true, isBuiltIn: ["ADMIN", "AC", "BT", "VN"].includes(role), version: (index+1).toString().repeat(64) }))
const harness = {
  mode: "conflict", reads: 0, requests: [] as Array<Record<string, unknown>>, routes: [] as string[], groups,
  auth: { loading: false, authenticated: true, resetRequired: false, role: "AC", username: "synthetic-operator",
    displayName: "Synthetic operator", permissions: { "user-management": "edit" }, pages: ADMIN_PAGE_DEFINITIONS },
  render: () => {},
}
declare global { interface Window { __permissionGroupHarness: typeof harness } }
window.__permissionGroupHarness = harness
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin) throw Error("No external fixture request is allowed")
  if (url.pathname === "/api/parser-reports") return Response.json({ readyForUserReview: 0 })
  if (url.pathname !== "/api/admin/users") throw Error("Unexpected fixture API")
  if ((init.method || "GET") === "GET") {
    harness.reads++
    return Response.json({ users: [{ id: "synthetic-user", username: "synthetic-staff", displayName: "Synthetic staff", email: "", emailVerified: false,
      isActive: true, useFcos: false, useSpc: false, passwordResetRequired: false, role: "BT", attendanceGroup: "BT", permissions: { ...policy },
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-22T01:00:00Z" }],
      pages: [{ id: "user-management", label: "User Management", group: "management", path: "/admin/usermanagement" },
        { id: "attendance-record", label: "Attendance Record", group: "office", path: "/admin/attendancerecord" }],
      roleDefaults: harness.groups, groupStorage: "shared-store" })
  }
  if (init.method !== "POST") throw Error("Unexpected fixture method")
  const payload = JSON.parse(String(init.body)); harness.requests.push(payload)
  if (harness.mode === "conflict") return Response.json({ code: "ADMIN_PERMISSION_GROUP_CONFLICT",
    message: "This permission group changed or was removed. Your changes were not saved. Reload groups before trying again." }, { status: 409 })
  const roleDefault = payload.roleDefault
  const group = harness.groups.find(group => group.role === roleDefault.role)
  if (!group || roleDefault.expectedVersion !== group.version) throw Error("Fixture must preserve the selected base version")
  group.permissions = roleDefault.permissions
  group.version = "f".repeat(64)
  return Response.json({ success: true, roleDefault: group })
}
const app = createRoot(document.getElementById("root")!)
harness.render = () => app.render(<div className="fc-admin-scope"><AdminNavigationShell><Page /></AdminNavigationShell></div>)
harness.render()
