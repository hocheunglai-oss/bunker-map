import { AdminRouteGuard } from "@/components/AdminRouteGuard"
import { AdminNavigationShell } from "@/components/AdminNavigationShell"

export const dynamic = "force-dynamic"

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
