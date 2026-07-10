import { AdminRouteGuard } from "@/components/AdminRouteGuard"
import { AdminNavigationShell } from "@/components/AdminNavigationShell"

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="fc-admin-scope">
      <AdminNavigationShell>
        <AdminRouteGuard>{children}</AdminRouteGuard>
      </AdminNavigationShell>
    </div>
  )
}
