const DINGTALK_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken"
const DINGTALK_ATTENDANCE_URL = "https://oapi.dingtalk.com/attendance/listRecord"

const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000

export const DINGTALK_ATTENDANCE_MAX_USERS = 50
export const DINGTALK_ATTENDANCE_MAX_RANGE_DAYS = 7
export const DINGTALK_ATTENDANCE_MAX_AGE_DAYS = 180

export type DingTalkAttendanceQuery = {
  userIds: string[]
  checkDateFrom: string
  checkDateTo: string
  isI18n: boolean
}

export type DingTalkAttendanceRecord = Record<string, unknown>

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

type DingTalkAttendanceClientOptions = {
  appKey: string
  appSecret: string
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
}

type CachedToken = {
  value: string
  expiresAt: number
}

export class DingTalkAttendanceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DingTalkAttendanceValidationError"
  }
}

export class DingTalkAttendanceConfigurationError extends Error {
  constructor() {
    super("DingTalk attendance credentials are not configured.")
    this.name = "DingTalkAttendanceConfigurationError"
  }
}

export class DingTalkAttendanceUpstreamError extends Error {
  readonly upstreamCode: string | null
  readonly upstreamStatus: number

  constructor(
    message: string,
    options: { upstreamCode?: string | null; upstreamStatus?: number } = {},
  ) {
    super(message)
    this.name = "DingTalkAttendanceUpstreamError"
    this.upstreamCode = options.upstreamCode || null
    this.upstreamStatus = options.upstreamStatus || 502
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseHongKongTimestamp(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const timestamp =
    Date.UTC(year, month - 1, day, hour, minute, second) - HONG_KONG_OFFSET_MS
  const localCheck = new Date(timestamp + HONG_KONG_OFFSET_MS)

  if (
    localCheck.getUTCFullYear() !== year ||
    localCheck.getUTCMonth() !== month - 1 ||
    localCheck.getUTCDate() !== day ||
    localCheck.getUTCHours() !== hour ||
    localCheck.getUTCMinutes() !== minute ||
    localCheck.getUTCSeconds() !== second
  ) {
    return null
  }

  return timestamp
}

function requireTimestamp(value: unknown, fieldName: string) {
  if (typeof value !== "string") {
    throw new DingTalkAttendanceValidationError(
      `${fieldName} must use YYYY-MM-DD HH:mm:ss in Hong Kong time.`,
    )
  }

  const timestamp = parseHongKongTimestamp(value)
  if (timestamp === null) {
    throw new DingTalkAttendanceValidationError(
      `${fieldName} must use a valid YYYY-MM-DD HH:mm:ss value in Hong Kong time.`,
    )
  }

  return { value, timestamp }
}

export function validateDingTalkAttendanceQuery(
  input: unknown,
  now = Date.now(),
): DingTalkAttendanceQuery {
  if (!isRecord(input)) {
    throw new DingTalkAttendanceValidationError("A JSON request body is required.")
  }

  if (!Array.isArray(input.userIds) || input.userIds.length === 0) {
    throw new DingTalkAttendanceValidationError("userIds must contain at least one DingTalk user ID.")
  }

  if (input.userIds.length > DINGTALK_ATTENDANCE_MAX_USERS) {
    throw new DingTalkAttendanceValidationError(
      `DingTalk permits at most ${DINGTALK_ATTENDANCE_MAX_USERS} users per request.`,
    )
  }

  const userIds = [...new Set(input.userIds.map((value) => {
    if (typeof value !== "string") {
      throw new DingTalkAttendanceValidationError("Every DingTalk user ID must be a string.")
    }

    const userId = value.trim()
    if (!userId || userId.length > 128 || /[\u0000-\u001f\u007f]/.test(userId)) {
      throw new DingTalkAttendanceValidationError("A DingTalk user ID is invalid.")
    }
    return userId
  }))]

  const from = requireTimestamp(input.checkDateFrom, "checkDateFrom")
  const to = requireTimestamp(input.checkDateTo, "checkDateTo")

  if (from.timestamp > to.timestamp) {
    throw new DingTalkAttendanceValidationError("checkDateFrom must not be after checkDateTo.")
  }

  if (to.timestamp - from.timestamp > DINGTALK_ATTENDANCE_MAX_RANGE_DAYS * DAY_MS) {
    throw new DingTalkAttendanceValidationError(
      `DingTalk permits a maximum ${DINGTALK_ATTENDANCE_MAX_RANGE_DAYS}-day query window.`,
    )
  }

  if (from.timestamp < now - DINGTALK_ATTENDANCE_MAX_AGE_DAYS * DAY_MS) {
    throw new DingTalkAttendanceValidationError(
      `DingTalk does not return attendance data older than ${DINGTALK_ATTENDANCE_MAX_AGE_DAYS} days.`,
    )
  }

  if (input.isI18n !== undefined && typeof input.isI18n !== "boolean") {
    throw new DingTalkAttendanceValidationError("isI18n must be true or false.")
  }

  return {
    userIds,
    checkDateFrom: from.value,
    checkDateTo: to.value,
    isI18n: input.isI18n ?? true,
  }
}

async function readJsonObject(response: Response) {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new DingTalkAttendanceUpstreamError(
      "DingTalk returned an unreadable response.",
      { upstreamStatus: response.status },
    )
  }

  if (!isRecord(payload)) {
    throw new DingTalkAttendanceUpstreamError(
      "DingTalk returned an invalid response.",
      { upstreamStatus: response.status },
    )
  }

  return payload
}

function responseCode(payload: Record<string, unknown>) {
  const value = payload.errcode ?? payload.code
  if (value === undefined || value === null) return null

  const code = String(value)
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : null
}

export class DingTalkAttendanceClient {
  private readonly appKey: string
  private readonly appSecret: string
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly timeoutMs: number
  private cachedToken: CachedToken | null = null
  private tokenRequest: Promise<string> | null = null

  constructor(options: DingTalkAttendanceClientOptions) {
    this.appKey = options.appKey.trim()
    this.appSecret = options.appSecret.trim()
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis)
    this.now = options.now || Date.now
    this.timeoutMs = options.timeoutMs || 15_000

    if (!this.appKey || !this.appSecret) {
      throw new DingTalkAttendanceConfigurationError()
    }
  }

  private async requestToken() {
    const response = await this.fetchImpl(DINGTALK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appKey: this.appKey,
        appSecret: this.appSecret,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const payload = await readJsonObject(response)
    const token = payload.accessToken
    const expireIn = Number(payload.expireIn)

    if (
      !response.ok ||
      typeof token !== "string" ||
      !token ||
      !Number.isFinite(expireIn) ||
      expireIn <= 0
    ) {
      throw new DingTalkAttendanceUpstreamError(
        "DingTalk application authentication failed.",
        {
          upstreamCode: responseCode(payload),
          upstreamStatus: response.status,
        },
      )
    }

    this.cachedToken = {
      value: token,
      expiresAt: this.now() + Math.max(0, expireIn * 1000 - TOKEN_EXPIRY_MARGIN_MS),
    }
    return token
  }

  private async getToken() {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now()) {
      return this.cachedToken.value
    }

    if (!this.tokenRequest) {
      this.tokenRequest = this.requestToken().finally(() => {
        this.tokenRequest = null
      })
    }

    return this.tokenRequest
  }

  async listRecords(input: unknown) {
    const query = validateDingTalkAttendanceQuery(input, this.now())
    const accessToken = await this.getToken()
    const body = new URLSearchParams({
      checkDateFrom: query.checkDateFrom,
      checkDateTo: query.checkDateTo,
      isI18n: String(query.isI18n),
      userIds: JSON.stringify(query.userIds),
    })
    const response = await this.fetchImpl(
      `${DINGTALK_ATTENDANCE_URL}?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    )
    const payload = await readJsonObject(response)
    const code = responseCode(payload)

    if (!response.ok || code !== "0") {
      throw new DingTalkAttendanceUpstreamError(
        "DingTalk attendance retrieval failed.",
        { upstreamCode: code, upstreamStatus: response.status },
      )
    }

    const rawRecords = payload.recordresult
    if (
      (rawRecords !== undefined && rawRecords !== null && !Array.isArray(rawRecords)) ||
      (Array.isArray(rawRecords) && rawRecords.some((record) => !isRecord(record)))
    ) {
      throw new DingTalkAttendanceUpstreamError(
        "DingTalk returned invalid attendance records.",
        { upstreamCode: code, upstreamStatus: response.status },
      )
    }

    const records = (rawRecords || []) as DingTalkAttendanceRecord[]
    return { query, records }
  }
}

let defaultClient: DingTalkAttendanceClient | null = null

export function getDingTalkAttendanceClient() {
  if (defaultClient) return defaultClient

  const appKey = process.env.DINGTALK_CLIENT_ID
  const appSecret = process.env.DINGTALK_CLIENT_SECRET
  if (!appKey || !appSecret) {
    throw new DingTalkAttendanceConfigurationError()
  }

  defaultClient = new DingTalkAttendanceClient({ appKey, appSecret })
  return defaultClient
}
