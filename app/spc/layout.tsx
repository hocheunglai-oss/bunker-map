import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Singapore Purchasing Center",
}

export const dynamic = "force-dynamic"

export default function SpcLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return <div className="fc-admin-scope spc-scope">{children}</div>
}
