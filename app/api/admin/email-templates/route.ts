import { NextResponse } from "next/server"
import {
  deleteEmailTemplate,
  EmailTemplate,
  EmailTemplateConflictError,
  loadEmailTemplate,
  loadTemplateIndex,
  loadTemplateLibrary,
  repairEmailTemplateFormatting,
  saveEmailTemplate,
  saveTemplateLibrary,
} from "@/lib/emailTemplates"
import { createAdminAuditContext } from "@/lib/adminAudit"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { loadSharedAddressBookRecipients } from "@/lib/sharedAddressBookServer"

type SavePayload = {
  id?: string
  template?: EmailTemplate
  templates?: EmailTemplate[]
  expectedRevision?: number | null
  expectedUpdatedAt?: string | null
  expectedLibraryRevision?: string | null
}

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("email-templates", "view")
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")
    const mode = searchParams.get("mode") || searchParams.get("view")

    if (id) {
      const template = await loadEmailTemplate(id)
      if (!template) {
        return NextResponse.json({ message: "Template not found." }, { status: 404 })
      }

      return NextResponse.json(
        { template },
        {
          headers: {
            "Cache-Control": "private, no-store",
          },
        }
      )
    }

    if (mode === "index" || mode === "compact") {
      const library = await loadTemplateIndex()
      return NextResponse.json(
        library,
        {
          headers: {
            "Cache-Control": "private, no-store",
          },
        }
      )
    }

    if (mode === "recipients") {
      const recipients = await loadSharedAddressBookRecipients()
      return NextResponse.json(
        recipients,
        {
          headers: {
            "Cache-Control": "private, no-store",
          },
        }
      )
    }

    const [library, recipients] = await Promise.all([
      loadTemplateLibrary(),
      loadSharedAddressBookRecipients(),
    ])
    return NextResponse.json(
      {
        ...library,
        ...recipients,
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }

    return NextResponse.json({ message: "Failed to load templates." }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("email-templates", "edit")
    const auditContext = createAdminAuditContext(
      session,
      request,
      "email-templates"
    )

    const {
      action,
      id,
      template,
      templates,
      expectedRevision,
      expectedUpdatedAt,
      expectedLibraryRevision,
    } = (await request.json()) as SavePayload & {
      action?: string
    }
    const now = new Date().toISOString()

    if (action === "save") {
      if (!Array.isArray(templates)) {
        return NextResponse.json({ message: "Missing template library." }, { status: 400 })
      }

      if (!expectedLibraryRevision) {
        return NextResponse.json(
          {
            code: "EMAIL_TEMPLATE_CONFLICT",
            message: "The Outlook template library version is missing. Reload Outlook Templates before replacing the library.",
          },
          { status: 409 }
        )
      }

      const nextTemplates = Array.isArray(templates) ? templates : []
      const nextLibrary = {
        templates: nextTemplates,
        lastImportedAt: null,
        lastUpdatedAt: now,
        revision: expectedLibraryRevision,
      }

      const savedLibrary = await saveTemplateLibrary(nextLibrary, auditContext)

      return NextResponse.json(savedLibrary)
    }

    if (action === "save-template") {
      if (!template?.id) {
        return NextResponse.json({ message: "Missing template." }, { status: 400 })
      }

      const savedTemplate = await saveEmailTemplate(
        template,
        auditContext,
        {
          expectedRevision,
          expectedUpdatedAt,
        }
      )
      return NextResponse.json({
        template: savedTemplate,
        lastUpdatedAt: savedTemplate.updatedAt || now,
      })
    }

    if (action === "delete-template") {
      if (!id) {
        return NextResponse.json({ message: "Missing template id." }, { status: 400 })
      }

      if (expectedRevision == null && !expectedUpdatedAt) {
        return NextResponse.json(
          {
            code: "EMAIL_TEMPLATE_CONFLICT",
            message:
              "The template version is missing. Reload Outlook Templates before deleting it.",
          },
          { status: 409 },
        )
      }

      await deleteEmailTemplate(
        id,
        auditContext,
        {
          expectedRevision,
          expectedUpdatedAt,
        }
      )
      return NextResponse.json({ id, lastUpdatedAt: now })
    }

    if (action === "repair-formatting") {
      const result = await repairEmailTemplateFormatting(auditContext)
      return NextResponse.json({
        ...result,
        lastUpdatedAt: new Date().toISOString(),
      })
    }

    return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
  } catch (error) {
    if (error instanceof EmailTemplateConflictError) {
      return NextResponse.json(
        {
          code: error.code,
          message: error.message,
        },
        { status: 409 }
      )
    }

    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }

    return NextResponse.json({ message: "Template action failed." }, { status: 500 })
  }
}
