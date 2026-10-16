import { fcunoConnectionPolicy } from "@/config/fcunoConnections"

export type SpcHealthStatus = "ok" | "warning" | "error"
export type SpcHealthResponse = {
  status: SpcHealthStatus
  checkedAt: string
  deployment: { commit: string; shortCommit: string; branch: string; deployedAt: string; environment: string }
  freshness: { state: "fresh" | "cached" | "stale"; attemptedAt: string }
  checks: { id: string; label: string; status: SpcHealthStatus; message: string; checkedAt: string; details?: Record<string, string | number | boolean | null> }[]
}
export type SpcTechStackResponse = {
  generatedAt: string
  deployment: { platform: string; project: string; productionUrl: string; gitRepository: string; branch: string; commit: string }
  secrets: { name: string; configured: boolean; storage: string; value: "MASKED"; status: string }[]
  verification: { environmentValues: string }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function strings(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.every(key => typeof value[key] === "string" && (value[key] as string).length > 0)
}
function date(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function status(value: unknown): value is SpcHealthStatus {
  return value === "ok" || value === "warning" || value === "error"
}

export function parseSpcHealthResponse(value: unknown): SpcHealthResponse {
  if (!record(value) || !status(value.status) || !date(value.checkedAt) || !record(value.deployment)
    || !strings(value.deployment, ["commit", "shortCommit", "branch", "deployedAt", "environment"])
    || !record(value.freshness) || !["fresh", "cached", "stale"].includes(value.freshness.state as string)
    || !date(value.freshness.attemptedAt) || value.freshness.attemptedAt < value.checkedAt
    || !Array.isArray(value.checks) || value.checks.length === 0) throw new Error("Invalid SPC health response")
  const ids = new Set<string>()
  for (const check of value.checks) {
    if (!record(check) || !strings(check, ["id", "label", "message"]) || !status(check.status) || !date(check.checkedAt)
      || check.checkedAt !== value.checkedAt || ids.has(check.id as string)
      || (check.details !== undefined && (!record(check.details) || !Object.values(check.details).every(item =>
        item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))))) {
      throw new Error("Invalid SPC health check")
    }
    ids.add(check.id as string)
  }
  const overall = value.checks.some(check => check.status === "error") ? "error" : value.checks.some(check => check.status === "warning") ? "warning" : "ok"
  if (value.status !== overall) throw new Error("Inconsistent SPC health status")
  return value as SpcHealthResponse
}

export function parseSpcTechStackResponse(value: unknown): SpcTechStackResponse {
  if (!record(value) || !date(value.generatedAt) || !record(value.deployment)
    || !strings(value.deployment, ["platform", "project", "productionUrl", "gitRepository", "branch", "commit"])
    || value.deployment.productionUrl !== fcunoConnectionPolicy.vercel.productionOrigins[1]
    || value.deployment.project !== fcunoConnectionPolicy.vercel.project
    || value.deployment.gitRepository !== fcunoConnectionPolicy.github.repository
    || !record(value.verification) || value.verification.environmentValues !== "Presence only; credentials and external services are not checked."
    || !Array.isArray(value.secrets) || value.secrets.length === 0) throw new Error("Invalid SPC tech stack response")
  const names = new Set<string>()
  for (const secret of value.secrets) {
    if (!record(secret) || !strings(secret, ["name", "storage", "status"]) || typeof secret.configured !== "boolean" || secret.value !== "MASKED"
      || names.has(secret.name as string)
      || (secret.configured ? secret.status !== "PRESENT — NOT VALIDATED" : secret.status !== "NOT PRESENT" && secret.status !== "PLACEHOLDER — NOT VALIDATED")) {
      throw new Error("Invalid SPC secret register")
    }
    names.add(secret.name as string)
  }
  return value as SpcTechStackResponse
}

export function formatSpcOperationalTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + " HKT"
}
