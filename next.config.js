const isDevelopment = process.env.NODE_ENV === "development"

const officeFrameAncestors = [
  "'self'",
  "https://outlook.office.com",
  "https://outlook.office365.com",
  "https://*.office.com",
  "https://*.office365.com",
  "https://*.officeapps.live.com",
  "https://*.microsoft365.com",
  "https://*.cloud.microsoft",
].join(" ")

const enforcedContentSecurityPolicy = [
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${officeFrameAncestors}`,
  "upgrade-insecure-requests",
].join("; ")

const contentSecurityPolicyReportOnly = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""} https://s3.tradingview.com https://appsforoffice.microsoft.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://api.maptiler.com https://*.tile.openstreetmap.org",
  "font-src 'self' data:",
  "connect-src 'self' https://gglyugbrnyvyfktgwert.supabase.co https://api.maptiler.com https://www.googleapis.com",
  "media-src 'self' data: blob: https://gglyugbrnyvyfktgwert.supabase.co",
  "frame-src 'self' https://*.tradingview.com https://*.tradingview-widget.com https://drive.google.com https://docs.google.com https://www.hko.gov.hk",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${officeFrameAncestors}`,
  "upgrade-insecure-requests",
].join("; ")

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/api/backups/postgres": ["./.runtime/postgres/**/*", "./.runtime/postgres-source/root.crt"],
    "/api/backups/postgres-probe": ["./.runtime/postgres/**/*", "./.runtime/postgres-source/root.crt"],
    "/api/admin/system-health/postgres-backup": ["./.runtime/postgres/**/*", "./.runtime/postgres-source/root.crt"],
    "/api/spc/chrome-extension/download": ["./tools/whatsapp-spc-speed-board/**/*"],
    "/api/spc/group-dispatcher/download": ["./tools/whatsapp-spc-group-dispatcher/**/*"],
    "/api/spc/group-dispatcher/files": ["./tools/whatsapp-spc-group-dispatcher/**/*"],
  },
  async redirects() {
    return [
      {
        source: "/readme",
        destination: "/presentation",
        permanent: true,
      },
      {
        source: "/spc/readme",
        destination: "/spc/presentation",
        permanent: true,
      },
    ]
  },
  async headers() {
    return [
      {
        // Only content-addressed, pinned font assets may be cached permanently.
        source: "/fonts/roboto/:font(roboto-v51-[a-z-]+\\.[a-f0-9]{16}\\.woff2)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/api/spc/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: enforcedContentSecurityPolicy,
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value: contentSecurityPolicyReportOnly,
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ]
  },
}

module.exports = nextConfig
