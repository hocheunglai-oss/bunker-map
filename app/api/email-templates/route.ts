import { NextResponse } from "next/server"
import { loadEmailTemplate, loadTemplateIndex, loadTemplateLibrary } from "@/lib/emailTemplates"

export const dynamic = "force-dynamic"
export const revalidate = 0

function sortByFolderAndTitle<T extends { folder?: string; title?: string }>(templates: T[]) {
  return templates.sort((a, b) => {
    const folderCompare = (a.folder || "").localeCompare(b.folder || "")
    if (folderCompare !== 0) return folderCompare
    return (a.title || "").localeCompare(b.title || "")
  })
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")
    const mode = searchParams.get("mode") || searchParams.get("view")

    if (id) {
      const template = await loadEmailTemplate(id)
      if (!template || template.isActive === false) {
        return NextResponse.json(
          { message: "Template not found." },
          {
            status: 404,
            headers: {
              "Cache-Control": "private, max-age=30, stale-while-revalidate=300",
              "Access-Control-Allow-Origin": "*",
            },
          }
        )
      }

      return NextResponse.json(
        { template },
        {
          headers: {
            "Cache-Control": "private, max-age=120, stale-while-revalidate=600",
            "Access-Control-Allow-Origin": "*",
          },
        }
      )
    }

    if (mode === "index" || mode === "compact") {
      const library = await loadTemplateIndex()
      const templates = sortByFolderAndTitle(library.templates.filter((template) => template.isActive !== false))

      return NextResponse.json(
        {
          templates,
          lastImportedAt: library.lastImportedAt,
          lastUpdatedAt: library.lastUpdatedAt,
        },
        {
          headers: {
            "Cache-Control": "private, max-age=30, stale-while-revalidate=300",
            "Access-Control-Allow-Origin": "*",
          },
        }
      )
    }

    const library = await loadTemplateLibrary()
    const templates = sortByFolderAndTitle(library.templates.filter((template) => template.isActive !== false))

    return NextResponse.json(
      {
        templates,
        lastImportedAt: library.lastImportedAt,
        lastUpdatedAt: library.lastUpdatedAt,
      },
      {
        headers: {
          "Cache-Control": "private, max-age=30, stale-while-revalidate=300",
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
