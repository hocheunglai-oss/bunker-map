import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { createSpcWhatsappApiGroup, SpcWhatsappGroupsError } from "@/lib/spcWhatsappGroups"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  })
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-chrome-extension", "edit")
    const payload = (await request.json()) as { subject?: unknown }
    const group = await createSpcWhatsappApiGroup(payload.subject)
    const auditContext = createSpcAuditContext(session, request, "spc-chrome-extension")
    const supabase = createSpcAuditedSupabaseClient(auditContext)
    const { error } = await supabase.from("audit_logs").insert({
      actor_user_id: auditContext.actorUserId,
      actor_id: `spc:${auditContext.username}`,
      actor_name: auditContext.displayName,
      actor_source: "app",
      table_schema: "public",
      table_name: "spc_whatsapp_groups",
      operation: "INSERT",
      record_pk: { id: group.id },
      changed_fields: ["id", "subject", "created_at", "reused"],
      before_row: null,
      after_row: {
        id: group.id,
        subject: group.subject,
        created_at: group.createdAt,
        reused: group.reused,
      },
      request_context: {
        pageId: auditContext.pageId,
        pageLabel: auditContext.pageLabel,
        pagePath: auditContext.pagePath,
      },
    })
    if (error) {
      console.error("Failed to audit SPC WhatsApp API group creation", {
        groupId: group.id,
        auditCode: error.code || null,
      })
    }
    return privateJson({
      success: true,
      group,
      warning: error
        ? "The WhatsApp group is ready, but its audit record could not be saved. Do not create it again."
        : undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create the WhatsApp API group."
    const status = message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : error instanceof SpcWhatsappGroupsError
          ? 422
          : 400
    return privateJson({ message }, status)
  }
}
