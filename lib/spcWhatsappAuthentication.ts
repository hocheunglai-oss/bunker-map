import { normaliseSpcWhatsappPhone } from "@/lib/spcUsers"

const META_REQUEST_TIMEOUT_MS = 10_000
const PHONE_PATTERN = /^[1-9][0-9]{7,14}$/
const GRAPH_VERSION_PATTERN = /^v[0-9]{1,3}\.[0-9]{1,2}$/
const GRAPH_ID_PATTERN = /^[0-9]{5,30}$/
const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/
const TEMPLATE_LANGUAGE_PATTERN = /^[a-z]{2,3}(?:_[A-Z]{2})?$/

export class SpcWhatsappAuthenticationDeliveryError extends Error {
  readonly category:
    | "configuration"
    | "timeout"
    | "rejected"
    | "template-unavailable"
    | "invalid-response"
  readonly upstreamStatus: number | null
  readonly upstreamCode: string | null

  constructor(
    category: SpcWhatsappAuthenticationDeliveryError["category"],
    options: { upstreamStatus?: number; upstreamCode?: string } = {},
  ) {
    super("WhatsApp could not accept the authentication message.")
    this.name = "SpcWhatsappAuthenticationDeliveryError"
    this.category = category
    this.upstreamStatus = options.upstreamStatus || null
    this.upstreamCode = options.upstreamCode || null
  }
}

function requireAuthenticationEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new SpcWhatsappAuthenticationDeliveryError("configuration")
  return value
}

function safeUpstreamCode(payload: unknown) {
  if (!payload || typeof payload !== "object") return null
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== "object") return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" || typeof code === "number"
    ? String(code).slice(0, 32)
    : null
}

function safeMessageId(payload: unknown) {
  if (!payload || typeof payload !== "object") return ""
  const messages = (payload as { messages?: unknown }).messages
  if (!Array.isArray(messages) || !messages[0] || typeof messages[0] !== "object") {
    return ""
  }
  const id = String((messages[0] as { id?: unknown }).id || "").trim()
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) return ""
  return id
}

export function maskSpcWhatsappPhone(value: string | null | undefined) {
  const digits = normaliseSpcWhatsappPhone(value)
  if (!PHONE_PATTERN.test(digits)) return ""
  const prefixLength = Math.min(2, digits.length - 4)
  const hiddenLength = Math.max(1, digits.length - prefixLength - 4)
  return `+${digits.slice(0, prefixLength)}${"•".repeat(hiddenLength)}${digits.slice(-4)}`
}

export function buildSpcWhatsappAuthenticationMessage(
  to: string,
  code: string,
  template: { name: string; language: string },
) {
  if (!PHONE_PATTERN.test(to)) throw new Error("The WhatsApp recipient is invalid.")
  if (!/^[0-9]{6}$/.test(code)) {
    throw new Error("The WhatsApp authentication code is invalid.")
  }
  if (
    !TEMPLATE_NAME_PATTERN.test(template.name) ||
    !TEMPLATE_LANGUAGE_PATTERN.test(template.language)
  ) {
    throw new Error("The WhatsApp authentication template is invalid.")
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: code }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: code }],
        },
      ],
    },
  }
}

export async function sendSpcWhatsappAuthenticationCode(
  input: { to: string; code: string },
  configuration: {
    phoneNumberId: string
    templateName: string
    templateLanguage: string
  },
  fetchImpl: typeof fetch = fetch,
) {
  const accessToken = requireAuthenticationEnv("WHATSAPP_ACCESS_TOKEN")
  const graphVersion = requireAuthenticationEnv("WHATSAPP_GRAPH_API_VERSION")
  const phoneNumberId = configuration.phoneNumberId.trim()
  const templateName = configuration.templateName.trim()
  const templateLanguage = configuration.templateLanguage.trim()
  if (
    !GRAPH_VERSION_PATTERN.test(graphVersion) ||
    !GRAPH_ID_PATTERN.test(phoneNumberId) ||
    !TEMPLATE_NAME_PATTERN.test(templateName) ||
    !TEMPLATE_LANGUAGE_PATTERN.test(templateLanguage)
  ) {
    throw new SpcWhatsappAuthenticationDeliveryError("configuration")
  }

  let response: Response
  try {
    response = await fetchImpl(
      `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          buildSpcWhatsappAuthenticationMessage(input.to, input.code, {
            name: templateName,
            language: templateLanguage,
          }),
        ),
        cache: "no-store",
        signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
      },
    )
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new SpcWhatsappAuthenticationDeliveryError("timeout")
    }
    throw new SpcWhatsappAuthenticationDeliveryError("rejected")
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const upstreamCode = safeUpstreamCode(payload)
    throw new SpcWhatsappAuthenticationDeliveryError(
      upstreamCode === "132001" ? "template-unavailable" : "rejected",
      {
        upstreamStatus: response.status,
        upstreamCode: upstreamCode || undefined,
      },
    )
  }

  const messageId = safeMessageId(payload)
  if (!messageId) {
    throw new SpcWhatsappAuthenticationDeliveryError("invalid-response")
  }
  return { messageId }
}
