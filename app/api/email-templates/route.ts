import { NextResponse } from "next/server"
import { requireOutlookAddinPagePermissionForRequest } from "@/lib/adminAuth"
import { loadEmailTemplate, loadTemplateIndex } from "@/lib/emailTemplates"

export const dynamic = "force-dynamic"
export const revalidate = 0

const RESPONSE_TTL_SECONDS = 120

function privateHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  }
}

function authError(error: unknown) {
  if (!(error instanceof Error)) return null
  if (error.message === "Unauthorized") {
    return NextResponse.json(
      { code: "SIGN_IN_REQUIRED", message: "Sign in to FC Uno to use Outlook Templates." },
      { status: 401, headers: privateHeaders() },
    )
  }
  if (error.message === "Forbidden") {
    return NextResponse.json(
      { code: "OUTLOOK_TEMPLATES_FORBIDDEN", message: "Outlook Templates view permission is required." },
      { status: 403, headers: privateHeaders() },
    )
  }
  return null
}

function responseMetadata() {
  const generatedAt = new Date()
  return {
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + RESPONSE_TTL_SECONDS * 1000).toISOString(),
    ttlSeconds: RESPONSE_TTL_SECONDS,
  }
}

function taskpaneTemplate(template: Awaited<ReturnType<typeof loadEmailTemplate>>) {
  if (!template) return null
  return {
    id: template.id,
    title: template.title,
    subject: template.subject,
    folder: template.folder,
    to: template.to,
    cc: template.cc,
    bcc: template.bcc,
    bodyHtml: template.bodyHtml,
    bodyText: template.bodyText,
    isActive: template.isActive,
    updatedAt: template.updatedAt,
    revision: template.revision,
    recipientResolution: template.recipientResolution,
  }
}

export async function GET(request: Request) {
  try {
    await requireOutlookAddinPagePermissionForRequest(
      request,
      "email-templates",
      "view",
    )
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")
    const metadata = responseMetadata()

    if (id) {
      const template = await loadEmailTemplate(id)
      if (!template || template.isActive === false) {
        return NextResponse.json(
          { code: "TEMPLATE_NOT_FOUND", message: "Template not found." },
          { status: 404, headers: privateHeaders() },
        )
      }

      return NextResponse.json(
        {
          schema: "fcuno.outlook-template-detail/v2",
          ...metadata,
          template: taskpaneTemplate(template),
        },
        { headers: privateHeaders() },
      )
    }

    const library = await loadTemplateIndex()
    const templates = library.templates
      .filter((template) => template.isActive !== false)
      .sort((left, right) => (
        left.folder.localeCompare(right.folder) || left.title.localeCompare(right.title)
      ))
      .map((template) => ({
        id: template.id,
        title: template.title,
        subject: template.subject,
        folder: template.folder,
        to: template.to,
        cc: template.cc,
        bcc: template.bcc,
        updatedAt: template.updatedAt,
        revision: template.revision,
      }))

    return NextResponse.json(
      {
        schema: "fcuno.outlook-template-index/v2",
        ...metadata,
        revision: library.revision,
        templates,
      },
      { headers: privateHeaders() },
    )
  } catch (error) {
    const response = authError(error)
    if (response) return response

    return NextResponse.json(
      { code: "TEMPLATE_READ_FAILED", message: "Outlook Templates are temporarily unavailable." },
      { status: 503, headers: privateHeaders() },
    )
  }
}
