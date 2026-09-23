import "server-only"
import { createHash } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import type { HealthAlertStore } from "@/lib/systemHealthAlerts"

export function createHealthAlertStore(recipient: string): HealthAlertStore {
  const normalizedRecipient = recipient.trim().toLowerCase()
  if (!normalizedRecipient) throw new Error("A System Health alert recipient is required.")
  // Deduplicate independently so one recipient's SMTP rejection does not mark
  // the incident delivered to them. Do not store email addresses in this table.
  const recipientKey = createHash("sha256").update(normalizedRecipient).digest("hex")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("System Health alert storage is not configured.")
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return {
    async claim(observations, token) {
      const { data, error } = await supabase.rpc("claim_system_health_alerts", {
        p_observations: observations, p_token: token, p_recipient_key: recipientKey,
      })
      if (error) throw new Error(`Unable to claim System Health alerts: ${error.message}`)
      if (!Array.isArray(data) || data.some((id) => typeof id !== "string")) {
        throw new Error("System Health alert storage returned an invalid claim.")
      }
      return data as string[]
    },
    async finish(token, delivered) {
      const { error } = await supabase.rpc("finish_system_health_alerts", {
        p_token: token, p_delivered: delivered,
      })
      if (error) throw new Error(`Unable to acknowledge System Health alerts: ${error.message}`)
    },
  }
}
