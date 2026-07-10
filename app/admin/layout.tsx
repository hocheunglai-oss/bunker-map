import { AdminRouteGuard } from "@/components/AdminRouteGuard"
import { AdminNavigationShell } from "@/components/AdminNavigationShell"
import { SimpleAdminAuthProvider } from "@/lib/useSimpleAdminAuth"

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="fc-admin-scope">
      <SimpleAdminAuthProvider>
        <AdminNavigationShell>
          <AdminRouteGuard>{children}</AdminRouteGuard>
        </AdminNavigationShell>
      </SimpleAdminAuthProvider>
    </div>
  )
}
