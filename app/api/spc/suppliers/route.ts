import { NextResponse } from "next/server"
import { createSpcAuditContext } from "@/lib/spcAudit"
import {
  hasSpcPagePermission,
  requireSpcSession,
} from "@/lib/spcAuth"
import {
  deleteSpcSupplier,
  loadSpcSupplierDataset,
  saveSpcSupplierBarges,
  saveSpcSupplierContacts,
  saveSpcSupplier,
} from "@/lib/spcSuppliers"
import type { SaveSpcSupplierBargesInput, SaveSpcSupplierContactsInput, SaveSpcSupplierInput } from "@/lib/spcSupplierTypes"

export const dynamic = "force-dynamic"

function statusForMessage(message: string) {
  if (message === "Unauthorized") return 401
  if (message === "Forbidden") return 403
  if (message.includes("required") || message.includes("not found")) return 400
  return 500
}

async function requireSupplierView() {
  const session = await requireSpcSession()
  if (
    !hasSpcPagePermission(session, "spc-suppliers", "view") &&
    !hasSpcPagePermission(session, "spc-fixtures", "view")
  ) {
    throw new Error("Forbidden")
  }
  return session
}

export async function GET() {
  try {
    await requireSupplierView()
    const dataset = await loadSpcSupplierDataset()
    return NextResponse.json(dataset, {
      headers: {
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load suppliers."
    return NextResponse.json({ message }, { status: statusForMessage(message) })
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSpcSession()
    if (!hasSpcPagePermission(session, "spc-suppliers", "edit")) {
      throw new Error("Forbidden")
    }
    const payload = (await request.json()) as {
      action?: unknown
      barges?: unknown
      contacts?: unknown
      key?: unknown
      supplier?: unknown
    }
    const context = createSpcAuditContext(session, request, "spc-suppliers")
    if (payload.action === "delete") {
      const key = typeof payload.key === "string" ? payload.key : ""
      const dataset = await deleteSpcSupplier(key, context)
      return NextResponse.json(dataset, {
        headers: {
          "Cache-Control": "private, no-store",
        },
      })
    }

    if (payload.action === "save-barges") {
      const barges =
        payload.barges && typeof payload.barges === "object"
          ? (payload.barges as SaveSpcSupplierBargesInput)
          : null
      if (!barges) throw new Error("Barge fleet details are required.")
      const dataset = await saveSpcSupplierBarges(barges, context)
      return NextResponse.json(dataset, {
        headers: {
          "Cache-Control": "private, no-store",
        },
      })
    }

    if (payload.action === "save-contacts") {
      const contacts =
        payload.contacts && typeof payload.contacts === "object"
          ? (payload.contacts as SaveSpcSupplierContactsInput)
          : null
      if (!contacts) throw new Error("Contact details are required.")
      const dataset = await saveSpcSupplierContacts(contacts, context)
      return NextResponse.json(dataset, {
        headers: {
          "Cache-Control": "private, no-store",
        },
      })
    }

    const supplier =
      payload.supplier && typeof payload.supplier === "object"
        ? (payload.supplier as SaveSpcSupplierInput)
        : null
    if (!supplier) throw new Error("Supplier details are required.")
    const dataset = await saveSpcSupplier(supplier, context)
    return NextResponse.json(dataset, {
      headers: {
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save supplier."
    return NextResponse.json({ message }, { status: statusForMessage(message) })
  }
}
