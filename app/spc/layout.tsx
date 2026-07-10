import type { Metadata } from "next"
import { SpcNavigationShell } from "@/components/SpcNavigationShell"
import { SpcAuthProvider } from "@/lib/useSpcAuth"

export const metadata: Metadata = {
  title: "Singapore Purchasing Center",
}

export default function SpcLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="fc-admin-scope spc-scope">
      <SpcAuthProvider>
        <SpcNavigationShell>{children}</SpcNavigationShell>
      </SpcAuthProvider>
    </div>
  )
}
