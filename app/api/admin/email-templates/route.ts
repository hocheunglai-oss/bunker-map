import { NextResponse } from "next/server"
import {
  EmailTemplate,
  importThunderbirdTemplates,
  loadTemplateLibrary,
  requireAdminSession,
  saveTemplateLibrary,
} from "@/lib/emailTemplates"

type SavePayload = {
  templates?: EmailTemplate[]
}

export async function GET() {
  try {
    await requireAdminSession()
    const library = await loadTemplateLibrary()
    return NextResponse.json(library)
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    return NextResponse.json({ message: "Failed to load templates." }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    await requireAdminSession()

    const { action, templates } = (await request.json()) as SavePayload & {
      action?: string
    }
    const now = new Date().toISOString()

    if (action === "import") {
      const library = await importThunderbirdTemplates()
      return NextResponse.json(library)
    }

    if (action === "save") {
      const library = await loadTemplateLibrary()
      const nextTemplates = Array.isArray(templates) ? templates : []
      const nextLibrary = {
        ...library,
        templates: nextTemplates,
        lastUpdatedAt: now,
      }

      await saveTemplateLibrary(nextLibrary)

      return NextResponse.json(nextLibrary)
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    return NextResponse.json({ message: "Template action failed." }, { status: 500 })
  }
}
