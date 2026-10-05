import { after } from "next/server"
import { requireAdminSession } from "@/lib/adminAuth"
import { getSpcSession } from "@/lib/spcAuth"
import { recordOpenAiUsage } from "@/lib/openAiUsage"
import { handleKnowledgeExtraction } from "@/lib/ecosystemKnowledgeExtraction"

export const runtime = "nodejs"
export const maxDuration = 60

function handle(request: Request) {
  return handleKnowledgeExtraction(request, {
    requireAdminSession,
    getSpcSession,
    fetch,
    recordUsage: async event => { after(() => recordOpenAiUsage(event)) },
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_KNOWLEDGE_MODEL || "gpt-6-luna",
  })
}

export const POST = handle
export const OPTIONS = handle
