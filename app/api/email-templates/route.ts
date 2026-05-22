import { NextResponse } from "next/server"
import { loadTemplateLibrary } from "@/lib/emailTemplates"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    const library = await loadTemplateLibrary()
    const templates = library.templates
      .filter((template) => template.isActive !== false)
      .sort((a, b) => {
        const folderCompare = (a.folder || "").localeCompare(b.folder || "")
        if (folderCompare !== 0) return folderCompare
        return (a.title || "").localeCompare(b.title || "")
      })

    return NextResponse.json(
      {
        templates,
        lastImportedAt: library.lastImportedAt,
        lastUpdatedAt: library.lastUpdatedAt,
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "Access-Control-Allow-Origin": "*",
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load templates." },
      {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      }
    )
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  })
}
