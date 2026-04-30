import type { Metadata } from "next"
import { Analytics } from "@vercel/analytics/next"
import "./globals.css"
import "leaflet/dist/leaflet.css"

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://cosulich.vercel.app"),
  title: "Bunker Map",
  description: "Live bunker prices, market reports, and admin publishing tools for bunker market coverage.",
  openGraph: {
    title: "Bunker Map",
    description: "Live bunker prices, market reports, and admin publishing tools for bunker market coverage.",
    images: [
      {
        url: "/homepage-preview.png",
        width: 632,
        height: 270,
        alt: "Fratelli Cosulich Market Intelligence",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Bunker Map",
    description: "Live bunker prices, market reports, and admin publishing tools for bunker market coverage.",
    images: ["/homepage-preview.png"],
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
