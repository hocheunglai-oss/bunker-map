/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/admin/*": ["./app/admin/**/*"],
  },
}

module.exports = nextConfig
