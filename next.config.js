/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    outputFileTracingIncludes: {
      "/api/admin/*": ["./app/admin/**/*"],
    },
  },
}

module.exports = nextConfig
