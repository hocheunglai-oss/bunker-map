import { NextResponse } from "next/server"
import { requireAdminPagePermission } from "@/lib/adminAuth"
import { AUDITED_TABLES, listAuditLogs, undoAuditLog } from "@/lib/auditLog"

export async function GET(request: Request) {
  try {
    await requireAdminPagePermission("audit-log", "view")

    const url = new URL(request.url)
    const logs = await listAuditLogs({
      tableName: url.searchParams.get("table"),
      operation: url.searchParams.get("operation"),
      actor: url.searchParams.get("actor"),
      limit: Number(url.searchParams.get("limit") || 100),
    })

    return NextResponse.json({
      logs,
      tables: AUDITED_TABLES,
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Failed to load audit logs.",
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminPagePermission("audit-log", "edit")
    const payload = (await request.json()) as { action?: string; id?: string }

    if (payload.action !== "undo") {
      return NextResponse.json({ message: "Unsupported action." }, { status: 400 })
    }

    if (!payload.id) {
      return NextResponse.json({ message: "Missing audit log id." }, { status: 400 })
    }

    const undoLogId = await undoAuditLog(payload.id, session)

    return NextResponse.json({
      success: true,
      undoLogId,
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 }
      )
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Failed to apply audit undo.",
      },
      { status: 500 }
    )
  }
}
