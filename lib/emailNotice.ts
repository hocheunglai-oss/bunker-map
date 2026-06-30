import nodemailer from "nodemailer"
import type SMTPTransport from "nodemailer/lib/smtp-transport"

const DEFAULT_NOTICE_FROM = "FC Uno <info@cosulich.com.hk>"
const DEFAULT_SMTP_HOST = "smtp.office365.com"
const DEFAULT_SMTP_PORT = 587

function cleanText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function extractEmailAddress(value: string) {
  const text = cleanText(value)
  return text.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/)?.[1] || (text.match(/^[^@\s]+@[^@\s]+\.[^@\s]+$/) ? text : "")
}

function parseSmtpPort(value: string | undefined) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_SMTP_PORT
}

function getNoticeFrom() {
  return cleanText(process.env.EMAIL_NOTICE_FROM) || DEFAULT_NOTICE_FROM
}

function getSmtpHost() {
  return cleanText(process.env.EXCHANGE_SMTP_HOST) || DEFAULT_SMTP_HOST
}

function getSmtpPort() {
  return parseSmtpPort(process.env.EXCHANGE_SMTP_PORT)
}

function getSmtpUser(from: string) {
  return cleanText(process.env.EXCHANGE_SMTP_USER) || extractEmailAddress(from) || "info@cosulich.com.hk"
}

export function normalizeEmailList(value: unknown) {
  const raw = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : ""

  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((item) => {
          const trimmed = item.trim().toLowerCase()
          return trimmed.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/)?.[1] || trimmed
        })
        .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
    )
  )
}

export function getEmailNoticeConfigStatus() {
  const from = getNoticeFrom()
  const user = getSmtpUser(from)
  const missing = [
    !user ? "EXCHANGE_SMTP_USER" : "",
    !process.env.EXCHANGE_SMTP_PASSWORD ? "EXCHANGE_SMTP_PASSWORD" : "",
  ].filter(Boolean)

  return {
    from,
    host: getSmtpHost(),
    port: getSmtpPort(),
    user,
    missing,
  }
}

export async function sendNoticeEmail(input: {
  to: string[]
  cc?: string[]
  subject: string
  html: string
}) {
  const config = getEmailNoticeConfigStatus()
  const password = process.env.EXCHANGE_SMTP_PASSWORD

  if (!config.user) throw new Error("EXCHANGE_SMTP_USER is not configured.")
  if (!password) throw new Error("EXCHANGE_SMTP_PASSWORD is not configured.")

  const transportOptions: SMTPTransport.Options = {
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: true,
    auth: {
      user: config.user,
      pass: password,
    },
    tls: {
      minVersion: "TLSv1.2",
    },
  }

  const transporter = nodemailer.createTransport(transportOptions)
  const result = await transporter.sendMail({
    from: config.from,
    to: input.to,
    ...(input.cc?.length ? { cc: input.cc } : {}),
    subject: input.subject,
    html: input.html,
  })

  return {
    id: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
  }
}
