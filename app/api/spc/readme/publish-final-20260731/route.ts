import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

const CHUNK_ID = "533d5a43-c8f7-4b81-9fc7-b03b27f82860"
const EXPECTED_REVISION = 18
const EXPECTED_BYTES = 26_678_887
const EXPECTED_SHA256 = "aeb5359c93838e53c634ddf14f532903bd6eaad0aa53381f264e6cfc36531628"
const MEDIA_PATH = `${CHUNK_ID}/video-20260731-what-comes-next-complete-synced.mp4`
const MEDIA_URL =
  "https://github.com/hocheunglai-oss/bunker-map/releases/download/spc-presentation-final-20260731/incorporate-ai-trading-final-chapter-complete-synced.mp4"
const BUCKET = "spc-presentation-media"

const NARRATION = `We will now return to the video presentation and ask one final question.

Final chapter. What comes next?

The key lesson from today is simple. AI is not a magic answer. It helps us move faster from a real business problem to a working solution. The people who understand the business remain in control.

The same approach can support other projects across the group. What else can we build?

First, a group-wide trading and intelligence platform. The enquiry parsing tool, fixture records, and lost records can be developed for other trading desks. Combined with credit control and market intelligence, they could provide a clearer picture for commercial decisions.

Second, a database of case studies: a structured solution platform. Real claims, operational problems, mistakes, and successful solutions could become searchable lessons. When a similar problem appears, staff would not need to start from zero or depend only on who remembers the case. AI could find relevant examples, summarise the lesson, and create training exercises. Experienced staff would verify the content.

Third, a purpose-built group AI assistant. We do not need to train a model from the beginning. A practical approach is to connect a strong model to approved company knowledge, case studies, systems, and business rules. It could support research, procedures, case searches, and writing drafts. Later, selected low-risk services could support customers, with human help.

Fourth, a semi-automated compliance screening platform. AI could summarise vessel movement, ownership, sanctions, and behavioural-risk information, then highlight cases that need closer review. But this depends on reliable maritime data. For now, Sea Searcher API costs may be difficult to justify. The project should remain on the roadmap until the business case is stronger.

These opportunities require more than occasional experiments. A prototype can be built quickly. A reliable system requires clean data, clear ownership, security, testing, maintenance, and user support. AI research and development should therefore be treated as a business capability, not a spare-time IT task.

We can begin with a small, dedicated team. It should be trader-led, but not trader-only. Traders understand the workflow, exceptions, and useful results. They should work with technical, credit, and compliance experts. A senior management sponsor should set priorities and remove barriers.

The process should remain simple. Identify a real problem. Build a small pilot. Test it with real users. Measure the result. Then improve it, scale it, or stop it. Not every idea should become a permanent system. The purpose of research and development is to learn quickly and invest based on evidence.

Finally, will AI replace bunker traders?

In the near future, AI is more likely to reshape the role than remove it. It can already read messages, conduct research, compare records, monitor deadlines, prepare options, draft communication, and use approved business systems.

But support is not ownership. AI does not carry the relationship, accept commercial responsibility, or remain accountable when information is incomplete and the decision is difficult. Those responsibilities still belong to people.

The strongest traders will use AI to spend less time rebuilding information and more time on judgement, relationships, negotiation, and commercial decisions. So, the real competition is not simply AI versus traders. It is between traders and companies that learn to use AI well, and those that do not.`

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

export async function POST() {
  try {
    const client = createClient(
      requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    )

    const { data: current, error: currentError } = await client
      .from("spc_presentation_chunks")
      .select("id,revision,media_version,video_path")
      .eq("id", CHUNK_ID)
      .maybeSingle()
    if (currentError) throw currentError
    if (!current) throw new Error("Final chapter was not found.")

    if (current.video_path === MEDIA_PATH && Number(current.revision) > EXPECTED_REVISION) {
      return NextResponse.json({ success: true, alreadyPublished: true, chunkId: CHUNK_ID })
    }
    if (Number(current.revision) !== EXPECTED_REVISION) {
      return NextResponse.json(
        {
          message: "Final chapter changed after the guarded publisher was prepared.",
          expectedRevision: EXPECTED_REVISION,
          actualRevision: current.revision,
        },
        { status: 409 },
      )
    }

    const mediaResponse = await fetch(MEDIA_URL, { cache: "no-store" })
    if (!mediaResponse.ok) {
      throw new Error(`Could not download verified media: HTTP ${mediaResponse.status}`)
    }
    const media = new Uint8Array(await mediaResponse.arrayBuffer())
    if (media.byteLength !== EXPECTED_BYTES) {
      throw new Error(`Media size mismatch: ${media.byteLength}`)
    }
    const digest = createHash("sha256").update(media).digest("hex")
    if (digest !== EXPECTED_SHA256) {
      throw new Error(`Media digest mismatch: ${digest}`)
    }

    const { error: uploadError } = await client.storage.from(BUCKET).upload(MEDIA_PATH, media, {
      contentType: "video/mp4",
      cacheControl: "3600",
      upsert: true,
    })
    if (uploadError) throw uploadError

    const { data: files, error: listError } = await client.storage
      .from(BUCKET)
      .list(CHUNK_ID, { search: MEDIA_PATH.split("/").pop(), limit: 2 })
    if (listError) throw listError
    const uploaded = (files || []).find((file) => `${CHUNK_ID}/${file.name}` === MEDIA_PATH)
    const uploadedBytes = Number(
      (uploaded?.metadata as { size?: number } | null | undefined)?.size || 0,
    )
    if (!uploaded || uploadedBytes !== EXPECTED_BYTES) {
      await client.storage.from(BUCKET).remove([MEDIA_PATH])
      throw new Error(`Uploaded media verification failed: ${uploadedBytes}`)
    }

    const previousPath = current.video_path as string | null
    const { data: updated, error: updateError } = await client
      .from("spc_presentation_chunks")
      .update({
        chapter_label: "FINAL CHAPTER",
        section_label: "WHAT COMES NEXT?",
        title: "WHAT COMES NEXT?",
        summary:
          "Practical next steps for group-wide AI capability, responsible research and development, and the future role of bunker traders.",
        narration: NARRATION,
        key_points: [],
        q_and_a_prompt: "",
        visual_kind: "video",
        duration_seconds: 300,
        video_path: MEDIA_PATH,
        video_mime_type: "video/mp4",
        video_bytes: EXPECTED_BYTES,
        media_version: Number(current.media_version) + 1,
        revision: EXPECTED_REVISION + 1,
        status: "published",
        updated_by_username: "Codex",
      })
      .eq("id", CHUNK_ID)
      .eq("revision", EXPECTED_REVISION)
      .select("id,revision,media_version,video_path,video_bytes,duration_seconds")
      .maybeSingle()
    if (updateError || !updated) {
      await client.storage.from(BUCKET).remove([MEDIA_PATH])
      throw updateError || new Error("Final chapter changed before publication completed.")
    }

    if (previousPath && previousPath !== MEDIA_PATH) {
      await client.storage.from(BUCKET).remove([previousPath])
    }

    return NextResponse.json({ success: true, chunk: updated })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not publish final chapter."
    return NextResponse.json({ message }, { status: 500 })
  }
}
