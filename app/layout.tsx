import type { Metadata } from "next"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"
import "leaflet/dist/leaflet.css"

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://cosulich.vercel.app"),
  title: "Fratelli Cosulich Uno",
  description: "Market Intelligence",
  openGraph: {
    title: "Fratelli Cosulich Uno",
    description: "Market Intelligence",
    images: [
      {
        url: "/uno-metadata-preview.png",
        width: 348,
        height: 170,
        alt: "Fratelli Cosulich Uno Market Intelligence",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fratelli Cosulich Uno",
    description: "Market Intelligence",
    images: ["/uno-metadata-preview.png"],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
