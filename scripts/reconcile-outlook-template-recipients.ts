import { createClient } from "@supabase/supabase-js"
import {
  loadTemplateLibrary,
  saveTemplateLibrary,
} from "@/lib/emailTemplates"
import {
  loadOutlookTemplateRecipientResolver,
} from "@/lib/outlookTemplateRecipientResolver"

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function isCurrentResolution(
  value: Record<string, unknown>,
  sourceFingerprint: string,
) {
  return (
    value.schema === "fcuno.outlook-template-recipient-resolution/v1" &&
    value.sourceFingerprint === sourceFingerprint
  )
}

async function main() {
  const apply = process.argv.includes("--apply")
  const [library, resolver] = await Promise.all([
    loadTemplateLibrary(),
    loadOutlookTemplateRecipientResolver(),
  ])
  const resolutions = library.templates.map((template) =>
    resolver.resolve({
      to: template.to,
      cc: template.cc,
      bcc: template.bcc,
    }),
  )
  const summary = resolutions.reduce(
    (counts, resolution, index) => {
      const previous = library.templates[index].recipientResolution
      if (!isCurrentResolution(previous, resolver.sourceFingerprint)) {
        counts.staleOrMissing += 1
      }
      if (resolution.counts.missing > 0) counts.withMissing += 1
      if (resolution.counts.ambiguous > 0) counts.withAmbiguous += 1
      if (
        resolution.counts.missing === 0 &&
        resolution.counts.ambiguous === 0
      ) {
        counts.sendable += 1
      }
      counts.recipientStatuses.missing += resolution.counts.missing
      counts.recipientStatuses.ambiguous += resolution.counts.ambiguous
      counts.recipientStatuses.external += resolution.counts.external
      return counts
    },
    {
      templates: library.templates.length,
      staleOrMissing: 0,
      withMissing: 0,
      withAmbiguous: 0,
      sendable: 0,
      recipientStatuses: {
        missing: 0,
        ambiguous: 0,
        external: 0,
      },
    },
  )

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    certificationRunId: resolver.certificationRunId,
    certifiedAt: resolver.certifiedAt,
    sourceFingerprint: resolver.sourceFingerprint,
    ...summary,
  }, null, 2))

  if (!apply) return

  await saveTemplateLibrary(
    library,
    {
      username: "system:outlook-template-reconcile",
      displayName: "Outlook Template Recipient Reconciliation",
      role: "system",
      pageId: "email-templates",
      pageLabel: "OUTLOOK TEMPLATES",
      pagePath: "/admin/outlooktemplates",
    },
  )

  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  )
  const { data, error } = await supabase.rpc(
    "verify_outlook_template_recipient_truth",
  )
  if (error) throw error

  const verification = data as {
    valid?: unknown
    templates?: unknown
  }
  if (verification.valid !== true) {
    throw new Error(
      `Recipient reconciliation did not verify: ${JSON.stringify(verification.templates || {})}`,
    )
  }

  console.log(JSON.stringify({
    mode: "verified",
    valid: true,
    templates: verification.templates,
  }, null, 2))
}

void main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : JSON.stringify(error),
  )
  process.exitCode = 1
})
