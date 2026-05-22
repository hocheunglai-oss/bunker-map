import type { Metadata } from "next"
import { Analytics } from "@vercel/analytics/next"
import ThemeToggle from "@/components/ThemeToggle"
import "./globals.css"
import "leaflet/dist/leaflet.css"

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
  const themeBootScript = `
    (function () {
      try {
        var key = "fcuno-theme-mode";
        var stored = window.localStorage.getItem(key);
        var theme = stored === "light" || stored === "dark"
          ? stored
          : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.dataset.theme = theme;
      } catch (error) {
        document.documentElement.dataset.theme = "dark";
      }
    })();
  `

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {children}
        <ThemeToggle />
        <Analytics />
      </body>
    </html>
  )
}
