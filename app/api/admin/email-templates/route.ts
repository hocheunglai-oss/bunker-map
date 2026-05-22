import { NextResponse } from "next/server"
import {
  deleteEmailTemplate,
  EmailTemplate,
  importThunderbirdTemplates,
  loadTemplateLibrary,
  requireAdminSession,
  saveEmailTemplate,
  saveTemplateLibrary,
} from "@/lib/emailTemplates"

type SavePayload = {
  id?: string
  template?: EmailTemplate
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

    const { action, id, template, templates } = (await request.json()) as SavePayload & {
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

    if (action === "save-template") {
      if (!template?.id) {
        return NextResponse.json({ message: "Missing template." }, { status: 400 })
      }

      const savedTemplate = await saveEmailTemplate(template)
      return NextResponse.json({
        template: savedTemplate,
        lastUpdatedAt: savedTemplate.updatedAt || now,
      })
    }

    if (action === "delete-template") {
      if (!id) {
        return NextResponse.json({ message: "Missing template id." }, { status: 400 })
      }

      await deleteEmailTemplate(id)
      return NextResponse.json({ id, lastUpdatedAt: now })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
    }

    return NextResponse.json({ message: "Template action failed." }, { status: 500 })
  }
}
