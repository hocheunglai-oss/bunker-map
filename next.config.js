/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Existing lint debt is tracked separately; production builds still run TypeScript checks.
    ignoreDuringBuilds: true,
  },
  outputFileTracingIncludes: {
    "/api/admin/*": ["./app/admin/**/*"],
  },
}

module.exports = nextConfig
