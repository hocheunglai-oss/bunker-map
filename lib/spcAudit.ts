import { createClient } from "@supabase/supabase-js"
import type { SpcSession } from "@/lib/spcAuth"
import { createTrustedRequestContext } from "@/lib/trustedRequestContext"

export type SpcAuditOutcome = "success" | "failed" | "denied"

export type SpcAuditActionContext = {
  action?: string
  targetType?: string | null
  targetId?: string | null
  targetUsername?: string | null
  outcome?: SpcAuditOutcome
  approvalReference?: string | null
  passwordChanged?: boolean
}

export type SpcAuditContext = {
  actorUserId: string
  username: string
  displayName: string
  role: string | null
  actorRole: string | null
  pageId: string
  pageLabel: string
  pagePath: string
  sourceIp: string | null
  correlationId: string
  requestId: string
  platformRequestId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  targetUsername: string | null
  outcome: SpcAuditOutcome
  approvalReference: string | null
  passwordChanged: boolean
}

export type SpcUserManagementAuditEventInput = {
  operation: "INSERT" | "UPDATE" | "DELETE"
  errorCode: string
}

const SPC_PAGE_LABELS: Record<string, string> = {
  "spc-buyer-enquiries": "SPC ENQUIRIES",
  "spc-chrome-extension": "SPC WHATSAPP EXTENSION",
  "spc-readme": "SPC INTRODUCTION",
  "spc-fixtures": "SPC FIXTURES",
  "spc-lost-record": "SPC LOST RECORD",
  "spc-statistics": "SPC STATISTICS",
  "spc-suppliers": "SPC SUPPLIER DATABASE",
  "spc-user-management": "SPC USER MANAGEMENT",
  "spc-mfa-test": "SPC MFA TEST",
  "spc-audit-log": "SPC AUDIT LOG",
  "spc-system-health": "SPC SYSTEM HEALTH",
  "spc-tech-stack": "SPC TECH STACK",
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function cleanAuditText(value: string | null | undefined, maximumLength: number) {
  const clean = value?.trim() || ""
  if (!clean) return null
  if (clean.length > maximumLength || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new Error("Invalid audit metadata.")
  }
  return clean
}

function cleanAuditCode(value: string | null | undefined, fallback: string) {
  const clean = value?.trim().toLowerCase() || fallback
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(clean)) {
    throw new Error("Invalid audit event code.")
  }
  return clean
}

function requireAuditActorUserId(value: string | null | undefined) {
  const clean = value?.trim().toLowerCase() || ""
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clean)) {
    throw new Error("Authenticated SPC user id is required for auditing.")
  }
  return clean
}

function pageFromRequest(request: Request | undefined, fallbackPageId: string) {
  const referer = request?.headers.get("referer")
  let pathname = ""

  if (referer) {
    try {
      pathname = new URL(referer).pathname
    } catch {
      pathname = ""
    }
  }

  return {
    pageId: fallbackPageId,
    pageLabel: SPC_PAGE_LABELS[fallbackPageId] || fallbackPageId.replace(/[-_]+/g, " ").toUpperCase(),
    pagePath: pathname || `/spc/${fallbackPageId.replace(/^spc-/, "")}`,
  }
}

export function createSpcAuditContext(
  session: SpcSession,
  request: Request | undefined,
  fallbackPageId: string,
  actionContext: SpcAuditActionContext = {},
): SpcAuditContext {
  if (!session.username) throw new Error("Authenticated username is required.")

  const requestContext = createTrustedRequestContext(request)
  const actorRole = session.role || null

  return {
    actorUserId: requireAuditActorUserId(session.userId),
    username: session.username,
    displayName: session.displayName || session.username,
    role: actorRole,
    actorRole,
    ...pageFromRequest(request, fallbackPageId),
    ...requestContext,
    action: cleanAuditCode(actionContext.action, "unspecified"),
    targetType: cleanAuditCode(actionContext.targetType, "unspecified"),
    targetId: cleanAuditText(actionContext.targetId, 256),
    targetUsername: cleanAuditText(actionContext.targetUsername, 320),
    outcome: actionContext.outcome || "success",
    approvalReference: cleanAuditText(actionContext.approvalReference, 256),
    passwordChanged: actionContext.passwordChanged === true,
  }
}

export function createSpcAuditHeaders(context: SpcAuditContext) {
  const headers: Record<string, string> = {
    "x-bunker-admin-user": `spc:${context.username}`,
    "x-bunker-admin-display-name": context.displayName,
    "x-bunker-audit-actor-user-id": context.actorUserId,
    "x-bunker-admin-role": context.actorRole || "",
    "x-bunker-admin-page-id": context.pageId,
    "x-bunker-admin-page-label": context.pageLabel,
    "x-bunker-admin-page-path": context.pagePath,
    "x-bunker-audit-correlation-id": context.correlationId,
    "x-bunker-audit-request-id": context.requestId,
    "x-bunker-audit-actor-role": context.actorRole || "",
    "x-bunker-audit-action": context.action,
    "x-bunker-audit-target-type": context.targetType || "",
    "x-bunker-audit-target-id": context.targetId || "",
    "x-bunker-audit-target-username": context.targetUsername || "",
    "x-bunker-audit-outcome": context.outcome,
    "x-bunker-audit-approval-reference": context.approvalReference || "",
    "x-bunker-audit-password-changed": context.passwordChanged ? "true" : "",
  }

  if (context.sourceIp) headers["x-bunker-audit-source-ip"] = context.sourceIp
  if (context.platformRequestId) {
    headers["x-bunker-audit-platform-request-id"] = context.platformRequestId
  }
  return headers
}

export function buildSpcUserManagementAuditEvent(
  context: SpcAuditContext,
  input: SpcUserManagementAuditEventInput,
) {
  if (context.outcome !== "failed" && context.outcome !== "denied") {
    throw new Error("Synthetic SPC user-management events are only for failed or denied actions.")
  }

  const errorCode = cleanAuditCode(input.errorCode, "unspecified")
  const compact = <T extends Record<string, unknown>>(value: T) =>
    Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== ""))

  return {
    actor_user_id: context.actorUserId,
    actor_id: `spc:${context.username}`,
    actor_name: context.displayName,
    actor_source: "app",
    table_schema: "app",
    table_name: "spc_user_management_events",
    operation: input.operation,
    record_pk: compact({
      requestId: context.requestId,
      targetType: context.targetType,
      targetId: context.targetId,
    }),
    changed_fields: [] as string[],
    before_row: null,
    after_row: compact({
      schema: "fcuno.spc-user-management-audit/v1",
      action: context.action,
      outcome: context.outcome,
      errorCode,
      targetType: context.targetType,
      targetId: context.targetId,
      targetUsername: context.targetUsername,
    }),
    request_context: compact({
      pageId: context.pageId,
      pageLabel: context.pageLabel,
      pagePath: context.pagePath,
      sourceIp: context.sourceIp,
      correlationId: context.correlationId,
      requestId: context.requestId,
      platformRequestId: context.platformRequestId,
      actorRole: context.actorRole,
      action: context.action,
      targetType: context.targetType,
      targetId: context.targetId,
      targetUsername: context.targetUsername,
      outcome: context.outcome,
      approvalReference: context.approvalReference,
      passwordChanged: context.passwordChanged || null,
    }),
  }
}

export function createSpcAuditedSupabaseClient(context: SpcAuditContext) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for SPC actions.")
  }

  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), serviceRoleKey, {
    global: {
      headers: createSpcAuditHeaders(context),
    },
  })
}

export async function recordSpcUserManagementAuditEvent(
  context: SpcAuditContext,
  input: SpcUserManagementAuditEventInput,
) {
  const supabase = createSpcAuditedSupabaseClient(context)
  const { error } = await supabase
    .from("audit_logs")
    .insert(buildSpcUserManagementAuditEvent(context, input))

  if (error) {
    throw new Error(
      `Failed to record SPC user-management security event (${context.correlationId}).`,
    )
  }
}
