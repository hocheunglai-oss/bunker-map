import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"
import { createSpcAuditContext, createSpcAuditedSupabaseClient } from "@/lib/spcAudit"
import { sendNoticeEmail } from "@/lib/emailNotice"
import {
  buildSpcSpeedBoardUpdateEmail,
  resolveSpcSpeedBoardNoticeRecipients,
  SPC_SPEED_BOARD_ROLE,
  SPC_SPEED_BOARD_VERSION,
} from "@/lib/spcSpeedBoardNotice"
import { listSupplierTraderOptions } from "@/lib/spcUsers"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to send the update notice."
  const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
  return NextResponse.json({ message }, { status })
}

async function recordUpdateNoticeAudit(
  context: ReturnType<typeof createSpcAuditContext>,
  recipientCount: number,
) {
  const sentAt = new Date().toISOString()
  const supabase = createSpcAuditedSupabaseClient(context)
  const title = `SPC Speed Board ${SPC_SPEED_BOARD_VERSION} update notice`
  const { error } = await supabase.from("audit_logs").insert({
    actor_id: `spc:${context.username}`,
    actor_name: context.displayName,
    actor_source: "app",
    table_schema: "public",
    table_name: "spc_speedboard_notices",
    operation: "INSERT",
    record_pk: { version: SPC_SPEED_BOARD_VERSION, sent_at: sentAt },
    changed_fields: ["version", "recipient_role", "recipient_count"],
    before_row: null,
    after_row: {
      title,
      version: SPC_SPEED_BOARD_VERSION,
      recipient_role: SPC_SPEED_BOARD_ROLE,
      recipient_count: recipientCount,
      sent_at: sentAt,
    },
    request_context: {
      pageId: context.pageId,
      pageLabel: context.pageLabel,
      pagePath: context.pagePath,
    },
  })
  if (error) throw error
}

export async function POST(request: Request) {
  try {
    const session = await requireSpcPagePermission("spc-chrome-extension", "edit")
    const supplierTraders = await listSupplierTraderOptions()
    const recipients = resolveSpcSpeedBoardNoticeRecipients(supplierTraders)
    const skipped = Math.max(supplierTraders.length - recipients.length, 0)

    if (!recipients.length) {
      return NextResponse.json(
        { message: "No active supplier trader has a valid email username." },
        { status: 400 },
      )
    }

    const email = buildSpcSpeedBoardUpdateEmail()
    await sendNoticeEmail({
      to: [],
      bcc: recipients,
      subject: email.subject,
      html: email.html,
    })

    const auditContext = createSpcAuditContext(session, request, "spc-chrome-extension")
    let auditRecorded = true
    try {
      await recordUpdateNoticeAudit(auditContext, recipients.length)
    } catch (error) {
      auditRecorded = false
      console.error("SPC Speed Board update notice audit failed", error)
    }

    const traderLabel = recipients.length === 1 ? "supplier trader" : "supplier traders"
    return NextResponse.json({
      success: true,
      message: `Update notice sent to ${recipients.length} ${traderLabel}.`,
      recipientCount: recipients.length,
      skipped,
      auditRecorded,
      warning: auditRecorded ? undefined : "Email sent, but the audit record could not be saved.",
    })
  } catch (error) {
    return errorResponse(error)
  }
}
