import "server-only"

export type SpcWhatsappApiGroup = {
  id: string
  subject: string
  createdAt: string | null
  inviteLink: string
  reused: boolean
}

type GroupApiConfig = {
  graphVersion: string
  phoneNumberId: string
  accessToken: string
}

type GroupApiOptions = {
  config?: GroupApiConfig
  fetchImpl?: typeof fetch
  wait?: (milliseconds: number) => Promise<void>
}

type MetaGroup = {
  id: string
  subject: string
  createdAt: string | null
}

export class SpcWhatsappGroupsError extends Error {
  readonly metaCode: string

  constructor(message: string, metaCode = "rejected") {
    super(message)
    this.name = "SpcWhatsappGroupsError"
    this.metaCode = metaCode
  }
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function defaultConfig(): GroupApiConfig {
  return {
    graphVersion: requireEnv("WHATSAPP_GRAPH_API_VERSION"),
    phoneNumberId: requireEnv("SPC_WHATSAPP_LOGIN_MFA_PHONE_NUMBER_ID"),
    accessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
  }
}

export function normalizeSpcWhatsappGroupSubject(value: unknown) {
  const subject = String(value || "").replace(/\s+/g, " ").trim()
  if (!subject) throw new Error("Group subject is required.")
  if (subject.length > 128) throw new Error("Group subject must be 128 characters or fewer.")
  return subject
}

function metaError(payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload
    ? (payload as { error?: { code?: unknown; message?: unknown; title?: unknown; error_data?: { details?: unknown } } }).error
    : null
  const code = String(error?.code || "rejected").slice(0, 32)
  const detail = String(error?.error_data?.details || error?.message || error?.title || "Request rejected.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
  return new SpcWhatsappGroupsError(`Meta Groups API rejected the request (${code}): ${detail}`, code)
}

async function metaRequest(
  path: string,
  init: RequestInit,
  config: GroupApiConfig,
  fetchImpl: typeof fetch,
) {
  const response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw metaError(payload)
  return payload
}

function parseGroups(payload: unknown): MetaGroup[] {
  const groups = payload && typeof payload === "object"
    ? (payload as { data?: { groups?: unknown } }).data?.groups
    : null
  if (!Array.isArray(groups)) return []
  return groups.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as { id?: unknown; subject?: unknown; created_at?: unknown }
    const id = String(row.id || "").trim()
    const subject = String(row.subject || "").replace(/\s+/g, " ").trim()
    if (!id || !subject) return []
    return [{ id, subject, createdAt: row.created_at == null ? null : String(row.created_at) }]
  })
}

async function listGroups(config: GroupApiConfig, fetchImpl: typeof fetch) {
  const payload = await metaRequest(
    `${encodeURIComponent(config.phoneNumberId)}/groups?limit=1024`,
    { method: "GET" },
    config,
    fetchImpl,
  )
  return parseGroups(payload)
}

async function getInviteLink(groupId: string, config: GroupApiConfig, fetchImpl: typeof fetch) {
  const payload = await metaRequest(
    `${encodeURIComponent(groupId)}/invite_link`,
    { method: "GET" },
    config,
    fetchImpl,
  )
  const inviteLink = payload && typeof payload === "object"
    ? String((payload as { invite_link?: unknown }).invite_link || "").trim()
    : ""
  if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+$/.test(inviteLink)) {
    throw new Error("Meta created the group but did not return a valid invite link.")
  }
  return inviteLink
}

export async function createSpcWhatsappApiGroup(subjectInput: unknown, options: GroupApiOptions = {}) {
  const subject = normalizeSpcWhatsappGroupSubject(subjectInput)
  const config = options.config || defaultConfig()
  const fetchImpl = options.fetchImpl || fetch
  const wait = options.wait || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const exactMatch = (groups: MetaGroup[]) => groups.find((group) => group.subject.toLowerCase() === subject.toLowerCase())

  const existing = exactMatch(await listGroups(config, fetchImpl))
  if (existing) {
    return {
      ...existing,
      inviteLink: await getInviteLink(existing.id, config, fetchImpl),
      reused: true,
    } satisfies SpcWhatsappApiGroup
  }

  await metaRequest(
    `${encodeURIComponent(config.phoneNumberId)}/groups`,
    {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        subject,
        description: "SPC official Groups API pilot group",
        join_approval_mode: "auto_approve",
      }),
    },
    config,
    fetchImpl,
  )

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (attempt > 0) await wait(1_000)
    const created = exactMatch(await listGroups(config, fetchImpl))
    if (!created) continue
    return {
      ...created,
      inviteLink: await getInviteLink(created.id, config, fetchImpl),
      reused: false,
    } satisfies SpcWhatsappApiGroup
  }

  throw new Error(
    "Meta accepted group creation, but the group is not visible yet. Wait one minute and reload this page before trying again.",
  )
}
