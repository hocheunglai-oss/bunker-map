import type { Metadata } from "next"
import { Analytics } from "@vercel/analytics/next"
import { SpeedInsights } from "@vercel/speed-insights/next"
import { preload } from "react-dom"
import "./fonts/roboto.css"
import "./globals.css"

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://cosulich.vercel.app"),
  title: "Fratelli Cosulich",
  description: "Market Intelligence",
  openGraph: {
    title: "Fratelli Cosulich",
    description: "Market Intelligence",
    images: [
      {
        url: "/uno-metadata-preview.png",
        width: 348,
        height: 170,
        alt: "Fratelli Cosulich Market Intelligence",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fratelli Cosulich",
    description: "Market Intelligence",
    images: ["/uno-metadata-preview.png"],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  preload("/fonts/roboto/roboto-v51-latin.0a44e0bb6ba5c853.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" })
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  )
}
