/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/admin/*": ["./app/admin/**/*"],
    "/api/spc/chrome-extension/download": ["./tools/whatsapp-spc-speed-board/**/*"],
  },
}

module.exports = nextConfig
