import { AdminRouteGuard } from "@/components/AdminRouteGuard"

export const dynamic = "force-dynamic"

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="fc-admin-scope">
      <AdminRouteGuard>{children}</AdminRouteGuard>
    </div>
  )
}
