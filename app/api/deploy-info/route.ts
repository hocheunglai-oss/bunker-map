import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function GET() {
  const commit =
    process.env.DEPLOY_COMMIT ||
    process.env.NEXT_PUBLIC_DEPLOY_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "unknown"
  const deployedAt =
    process.env.DEPLOYED_AT ||
    (process.env.VERCEL_GIT_COMMIT_SHA && process.env.VERCEL_ENV ? "vercel" : "unknown")

  return NextResponse.json({
    commit,
    shortCommit: commit === "unknown" ? commit : commit.slice(0, 7),
    branch:
      process.env.DEPLOY_BRANCH ||
      process.env.VERCEL_GIT_COMMIT_REF ||
      "unknown",
    deployedAt,
    environment:
      process.env.VERCEL_ENV ||
      process.env.NODE_ENV ||
      "unknown",
  })
}
