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
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load templates." },
      { status: 500 }
    )
  }
}
