"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { SpcShell } from "@/components/SpcShell"
import { PresentationMedia } from "@/components/spc-readme/PresentationMedia"
import { PresentationMotionScene } from "@/components/spc-readme/PresentationMotionScene"
import { canAccessSpcPage } from "@/lib/spcPages"
import type { SpcPresentationChunk } from "@/lib/spcPresentation"
import { useSpcAuth } from "@/lib/useSpcAuth"

const PRESENTATION_CACHE = "spc-presentation-media-v1"

type ReadmeResponse = {
  chunks?: SpcPresentationChunk[]
  canEdit?: boolean
  message?: string
}

type UploadResponse = {
  success?: boolean
  chunk?: SpcPresentationChunk
  upload?: {
    bucket: string
    path: string
    token: string
    signedUrl: string
  }
  message?: string
}

type ChunkDraft = {
  chapterLabel: string
  sectionLabel: string
  title: string
  summary: string
  narration: string
  keyPoints: string
  questionPrompt: string
  visualKind: string
  visualCopy: SpcPresentationChunk["visualCopy"]
  durationSeconds: string
  status: "draft" | "published"
}

type MediaSource = {
  chunkId: string
  video: string | null
  narration: string | null
}

type ResolvedMediaSource = {
  source: MediaSource
  objectUrls: string[]
}

const EMPTY_MEDIA_SOURCE: MediaSource = { chunkId: "", video: null, narration: null }

type OfflineState = "idle" | "checking" | "preparing" | "ready" | "partial" | "unavailable"
type PresenterMode = "manual" | "chapter" | null

function formatDuration(seconds: number | null) {
  if (!seconds) return "--:--"
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function formatBytes(value: number) {
  if (!value) return ""
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(value / 1024))} KB`
}

function chunkDraft(chunk: SpcPresentationChunk): ChunkDraft {
  return {
    chapterLabel: chunk.chapterLabel,
    sectionLabel: chunk.sectionLabel,
    title: chunk.title,
    summary: chunk.summary,
    narration: chunk.narration,
    keyPoints: chunk.keyPoints.join("\n"),
    questionPrompt: chunk.questionPrompt,
    visualKind: chunk.visualKind,
    visualCopy: chunk.visualCopy.map((item) => ({ ...item })),
    durationSeconds: chunk.durationSeconds ? String(chunk.durationSeconds) : "",
    status: chunk.status,
  }
}

function mediaCacheKey(chunk: SpcPresentationChunk, kind: "video" | "narration") {
  if (typeof window === "undefined") return ""
  return `${window.location.origin}/spc/readme/offline/${chunk.id}/${kind}/${chunk.mediaVersion}`
}

function chunkMediaItems(chunks: SpcPresentationChunk[]) {
  return chunks.flatMap((chunk) => {
    const items: Array<{
      chunk: SpcPresentationChunk
      kind: "video" | "narration"
      url: string
      expectedBytes: number
    }> = []
    if (chunk.videoUrl) {
      items.push({ chunk, kind: "video", url: chunk.videoUrl, expectedBytes: chunk.videoBytes })
    }
    if (chunk.narrationUrl) {
      items.push({ chunk, kind: "narration", url: chunk.narrationUrl, expectedBytes: chunk.narrationBytes })
    }
    return items
  })
}

async function resolveChunkMediaSource(chunk: SpcPresentationChunk): Promise<ResolvedMediaSource> {
  const objectUrls: string[] = []

  async function resolveOne(kind: "video" | "narration", fallback: string | null) {
    if (!fallback || !("caches" in window)) return fallback
    const cache = await window.caches.open(PRESENTATION_CACHE)
    const response = await cache.match(mediaCacheKey(chunk, kind))
    if (!response) return fallback
    const url = URL.createObjectURL(await response.blob())
    objectUrls.push(url)
    return url
  }

  try {
    const [video, narration] = await Promise.all([
      resolveOne("video", chunk.videoUrl),
      resolveOne("narration", chunk.narrationUrl),
    ])
    return { source: { chunkId: chunk.id, video, narration }, objectUrls }
  } catch {
    objectUrls.forEach((url) => URL.revokeObjectURL(url))
    return {
      source: { chunkId: chunk.id, video: chunk.videoUrl, narration: chunk.narrationUrl },
      objectUrls: [],
    }
  }
}

async function uploadToSignedStorageUrl(signedUrl: string, file: File) {
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
  const body = new FormData()
  body.append("cacheControl", "3600")
  body.append("", file)
  const response = await fetch(signedUrl, {
    method: "PUT",
    headers: {
      apikey: publicKey,
      Authorization: `Bearer ${publicKey}`,
      "x-upsert": "false",
    },
    body,
  })
  if (response.ok) return
  const result = (await response.json().catch(() => null)) as { message?: string } | null
  throw new Error(result?.message || "Could not upload presentation media.")
}

export default function SpcReadmePage() {
  const router = useRouter()
  const { loading: authLoading, authenticated, permissions } = useSpcAuth()
  const canView = canAccessSpcPage(permissions, "spc-readme", "view")
  const [chunks, setChunks] = useState<SpcPresentationChunk[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [loading, setLoading] = useState(true)
  const [canEdit, setCanEdit] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ChunkDraft | null>(null)
  const [referenceTab, setReferenceTab] = useState<"points" | "script" | "questions">("points")
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState<"video" | "narration" | "">("")
  const [mediaSource, setMediaSource] = useState<MediaSource>(EMPTY_MEDIA_SOURCE)
  const [offlineState, setOfflineState] = useState<OfflineState>("idle")
  const [offlineProgress, setOfflineProgress] = useState({ complete: 0, total: 0, bytes: 0 })
  const [presenterMode, setPresenterMode] = useState<PresenterMode>(null)
  const [presenterMediaSource, setPresenterMediaSource] = useState<MediaSource>(EMPTY_MEDIA_SOURCE)
  const [presenterTransitioning, setPresenterTransitioning] = useState(false)
  const [questionBreak, setQuestionBreak] = useState(false)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [online, setOnline] = useState(true)
  const presenterRef = useRef<HTMLDivElement>(null)
  const presenterAudioRef = useRef<HTMLAudioElement>(null)
  const presenterObjectUrlsRef = useRef<string[]>([])
  const presenterTransitioningRef = useRef(false)

  const selectedIndex = chunks.findIndex((chunk) => chunk.id === selectedId)
  const selected = selectedIndex >= 0 ? chunks[selectedIndex] : chunks[0] || null
  const chapterLabels = Array.from(new Set(chunks.map((chunk) => chunk.chapterLabel)))
  const activeChapter = selected?.chapterLabel || chapterLabels[0] || ""
  const chapterChunks = chunks.filter((chunk) => chunk.chapterLabel === activeChapter)
  const chapterSelectedIndex = chapterChunks.findIndex((chunk) => chunk.id === selected?.id)
  const selectedMedia = presenterMode
    ? presenterMediaSource.chunkId === selected?.id ? presenterMediaSource : EMPTY_MEDIA_SOURCE
    : mediaSource.chunkId === selected?.id ? mediaSource : EMPTY_MEDIA_SOURCE

  const loadChunks = useCallback(async () => {
    if (!authenticated || !canView) return
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/spc/readme", { cache: "no-store" })
      const result = (await response.json()) as ReadmeResponse
      if (!response.ok) throw new Error(result.message || "Could not load README content.")
      const nextChunks = result.chunks || []
      const nextCanEdit = Boolean(result.canEdit)
      setChunks(nextChunks)
      setCanEdit(nextCanEdit)
      if (!nextCanEdit) setEditing(false)
      setSelectedId((current) =>
        nextChunks.some((chunk) => chunk.id === current) ? current : nextChunks[0]?.id || "",
      )
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load README content.")
    } finally {
      setLoading(false)
    }
  }, [authenticated, canView])

  useEffect(() => {
    document.title = "SPC README"
  }, [])

  useEffect(() => {
    if (!authLoading && (!authenticated || !canView)) router.replace("/spc")
  }, [authLoading, authenticated, canView, router])

  useEffect(() => {
    // Initial data loading is intentionally tied to the authenticated page lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadChunks()
  }, [loadChunks])

  useEffect(() => {
    const update = () => setOnline(window.navigator.onLine)
    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])

  useEffect(() => {
    if (!selected) return
    // A newly selected chunk starts from its current stored revision.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(chunkDraft(selected))
    setQuestionBreak(false)
  }, [selected])

  useEffect(() => {
    let cancelled = false

    async function resolveSources() {
      if (!selected) {
        setMediaSource(EMPTY_MEDIA_SOURCE)
        return
      }

      const resolved = await resolveChunkMediaSource(selected)
      if (!cancelled) setMediaSource(resolved.source)
      else resolved.objectUrls.forEach((url) => URL.revokeObjectURL(url))
      return resolved.objectUrls
    }

    let objectUrls: string[] = []
    void resolveSources().then((urls) => {
      objectUrls = urls || []
    })

    return () => {
      cancelled = true
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [selected])

  useEffect(() => () => {
    presenterObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    presenterObjectUrlsRef.current = []
  }, [])

  const checkOffline = useCallback(async () => {
    const items = chunkMediaItems(chunks.filter((chunk) => chunk.status === "published"))
    if (!("caches" in window)) {
      setOfflineState("unavailable")
      return
    }
    if (items.length === 0) {
      setOfflineProgress({ complete: 0, total: 0, bytes: 0 })
      setOfflineState("idle")
      return
    }

    setOfflineState("checking")
    const cache = await window.caches.open(PRESENTATION_CACHE)
    const matches = await Promise.all(
      items.map((item) => cache.match(mediaCacheKey(item.chunk, item.kind))),
    )
    const complete = matches.filter(Boolean).length
    const cachedBytes = items.reduce(
      (total, item, index) => total + (matches[index] ? item.expectedBytes : 0),
      0,
    )
    setOfflineProgress({ complete, total: items.length, bytes: cachedBytes })
    setOfflineState(complete === items.length ? "ready" : "partial")
  }, [chunks])

  useEffect(() => {
    // Re-check the explicit media cache whenever the published chunk list changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (chunks.length > 0) void checkOffline()
  }, [chunks, checkOffline])

  useEffect(() => {
    if (!presenterMode) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePresentation()
      if (event.key === "ArrowRight" && !editing) {
        const nextChunk = chapterChunks[chapterSelectedIndex + 1]
        if (nextChunk) void activatePresenterSection(nextChunk)
      }
      if (event.key === "ArrowLeft" && !editing) {
        const previousChunk = chapterChunks[chapterSelectedIndex - 1]
        if (previousChunk) void activatePresenterSection(previousChunk)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  })

  useEffect(() => {
    if (
      presenterMode !== "chapter" ||
      questionBreak ||
      !selected ||
      mediaSource.chunkId !== selected.id ||
      mediaSource.video ||
      mediaSource.narration
    ) {
      return
    }

    const nextId = chapterChunks[chapterSelectedIndex + 1]?.id
    const timer = window.setTimeout(() => {
      if (nextId) setSelectedId(nextId)
      else setQuestionBreak(true)
    }, Math.max(selected.durationSeconds || 8, 3) * 1000)
    return () => window.clearTimeout(timer)
  }, [
    chapterChunks,
    chapterSelectedIndex,
    mediaSource,
    presenterMode,
    questionBreak,
    selected,
  ])

  useEffect(() => {
    if (!presenterMode || questionBreak || !selectedMedia.narration) return
    const audio = presenterAudioRef.current
    if (!audio) return

    let cancelled = false
    void audio.play()
      .then(() => {
        if (!cancelled) setPlaybackBlocked(false)
      })
      .catch(() => {
        if (!cancelled) setPlaybackBlocked(true)
      })
    return () => {
      cancelled = true
    }
  }, [presenterMode, questionBreak, selected?.id, selectedMedia.narration])

  function updateChunk(chunk: SpcPresentationChunk) {
    setChunks((current) =>
      current
        .map((item) => (item.id === chunk.id ? chunk : item))
        .sort((a, b) => a.sortOrder - b.sortOrder),
    )
    setSelectedId(chunk.id)
  }

  async function postAction(payload: Record<string, unknown>) {
    const response = await fetch("/api/spc/readme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const result = (await response.json()) as UploadResponse & ReadmeResponse
    if (!response.ok) throw new Error(result.message || "Could not update README content.")
    return result
  }

  async function saveDraft() {
    if (!selected || !draft) return
    setSaving(true)
    setError("")
    setMessage("")
    try {
      const result = await postAction({
        action: "save",
        chunk: {
          id: selected.id,
          revision: selected.revision,
          chapterLabel: draft.chapterLabel,
          sectionLabel: draft.sectionLabel,
          title: draft.title,
          summary: draft.summary,
          narration: draft.narration,
          keyPoints: draft.keyPoints.split("\n").map((line) => line.trim()).filter(Boolean),
          questionPrompt: draft.questionPrompt,
          visualKind: draft.visualKind,
          visualCopy: draft.visualCopy,
          durationSeconds: draft.durationSeconds ? Number(draft.durationSeconds) : null,
          status: draft.status,
        },
      })
      if (result.chunk) updateChunk(result.chunk)
      setEditing(false)
      setMessage("README section updated.")
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the section.")
    } finally {
      setSaving(false)
    }
  }

  async function addChunk() {
    setSaving(true)
    setError("")
    try {
      const result = await postAction({
        action: "save",
        chunk: {
          chapterLabel: activeChapter || "CHAPTER 1",
          sectionLabel: "NEW SECTION",
          title: "UNTITLED SECTION",
          summary: "",
          narration: "",
          keyPoints: [],
          questionPrompt: "",
          visualKind: "chapter-takeaway",
          visualCopy: [],
          durationSeconds: null,
          status: "draft",
        },
      })
      if (result.chunk) {
        setChunks((current) => [...current, result.chunk!].sort((a, b) => a.sortOrder - b.sortOrder))
        setSelectedId(result.chunk.id)
        setEditing(true)
      }
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Could not add the section.")
    } finally {
      setSaving(false)
    }
  }

  async function moveChunk(direction: "earlier" | "later") {
    if (!selected) return
    setSaving(true)
    setError("")
    try {
      const result = await postAction({ action: "move", id: selected.id, direction })
      if (result.chunks) setChunks(result.chunks)
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "Could not move the section.")
    } finally {
      setSaving(false)
    }
  }

  async function deleteChunk() {
    if (!selected || !window.confirm(`Delete "${selected.title}"? This cannot be undone.`)) return
    setSaving(true)
    setError("")
    try {
      await postAction({ action: "delete", id: selected.id })
      const remaining = chunks.filter((chunk) => chunk.id !== selected.id)
      setChunks(remaining)
      setSelectedId(remaining[Math.max(0, selectedIndex - 1)]?.id || "")
      setEditing(false)
      setMessage("README section deleted.")
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete the section.")
    } finally {
      setSaving(false)
    }
  }

  async function uploadMedia(kind: "video" | "narration", file: File) {
    if (!selected) return
    setUploading(kind)
    setError("")
    setMessage("")
    try {
      const prepared = await postAction({
        action: "prepare-upload",
        id: selected.id,
        kind,
        fileName: file.name,
        mimeType: file.type,
        fileBytes: file.size,
      })
      if (!prepared.upload) throw new Error("Could not prepare the media upload.")
      await uploadToSignedStorageUrl(prepared.upload.signedUrl, file)

      const completed = await postAction({
        action: "complete-upload",
        id: selected.id,
        revision: selected.revision,
        kind,
        path: prepared.upload.path,
        mimeType: file.type,
      })
      if (completed.chunk) updateChunk(completed.chunk)
      setMessage(kind === "video" ? "Video attached." : "Narration attached.")
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload media.")
    } finally {
      setUploading("")
    }
  }

  async function prepareOffline() {
    const items = chunkMediaItems(chunks.filter((chunk) => chunk.status === "published"))
    if (!("caches" in window)) {
      setOfflineState("unavailable")
      return
    }
    if (items.length === 0) {
      setMessage("No video or narration has been attached yet.")
      return
    }

    setOfflineState("preparing")
    setOfflineProgress({ complete: 0, total: items.length, bytes: 0 })
    setError("")
    setMessage("")
    try {
      if (window.navigator.storage?.persist) {
        await window.navigator.storage.persist().catch(() => false)
      }
      const cache = await window.caches.open(PRESENTATION_CACHE)
      const validKeys = new Set(items.map((item) => mediaCacheKey(item.chunk, item.kind)))
      const existingKeys = await cache.keys()
      await Promise.all(
        existingKeys
          .filter((request) => request.url.includes("/spc/readme/offline/") && !validKeys.has(request.url))
          .map((request) => cache.delete(request)),
      )

      let complete = 0
      let totalBytes = 0
      for (const item of items) {
        const key = mediaCacheKey(item.chunk, item.kind)
        let response = await cache.match(key)
        if (!response) {
          const networkResponse = await fetch(item.url)
          if (!networkResponse.ok) throw new Error(`Could not download ${item.chunk.title}.`)
          const blob = await networkResponse.blob()
          if (item.expectedBytes > 0 && Math.abs(blob.size - item.expectedBytes) > 1024) {
            throw new Error(`Downloaded media for ${item.chunk.title} is incomplete.`)
          }
          response = new Response(blob, {
            headers: { "Content-Type": blob.type || "application/octet-stream" },
          })
          await cache.put(key, response.clone())
          totalBytes += blob.size
        } else {
          totalBytes += item.expectedBytes
        }
        complete += 1
        setOfflineProgress({ complete, total: items.length, bytes: totalBytes })
      }

      setOfflineState("ready")
      setMessage("All presentation media is ready offline. Keep this tab open during the session.")
    } catch (prepareError) {
      setOfflineState("partial")
      setError(prepareError instanceof Error ? prepareError.message : "Could not prepare offline media.")
    }
  }

  async function activatePresenterSection(chunk: SpcPresentationChunk) {
    if (presenterTransitioningRef.current) return false
    presenterTransitioningRef.current = true
    setPresenterTransitioning(true)
    try {
      const resolved = await resolveChunkMediaSource(chunk)
      const previousObjectUrls = presenterObjectUrlsRef.current
      presenterObjectUrlsRef.current = resolved.objectUrls
      setPresenterMediaSource(resolved.source)
      setSelectedId(chunk.id)
      setQuestionBreak(false)
      setPlaybackBlocked(false)
      window.setTimeout(() => previousObjectUrls.forEach((url) => URL.revokeObjectURL(url)), 0)
      return true
    } finally {
      presenterTransitioningRef.current = false
      setPresenterTransitioning(false)
    }
  }

  function closePresentation() {
    setPresenterMode(null)
    setPresenterMediaSource(EMPTY_MEDIA_SOURCE)
    presenterTransitioningRef.current = false
    setPresenterTransitioning(false)
    setPlaybackBlocked(false)
    const objectUrls = presenterObjectUrlsRef.current
    presenterObjectUrlsRef.current = []
    window.setTimeout(() => objectUrls.forEach((url) => URL.revokeObjectURL(url)), 0)
  }

  function showPreviousSection() {
    if (chapterSelectedIndex <= 0) return
    void activatePresenterSection(chapterChunks[chapterSelectedIndex - 1])
  }

  function showNextSection() {
    if (chapterSelectedIndex < 0 || chapterSelectedIndex >= chapterChunks.length - 1) return
    void activatePresenterSection(chapterChunks[chapterSelectedIndex + 1])
  }

  function selectChapter(chapterLabel: string) {
    const firstChunk = chunks.find((chunk) => chunk.chapterLabel === chapterLabel)
    if (!firstChunk) return
    setSelectedId(firstChunk.id)
    setEditing(false)
    setQuestionBreak(false)
    setPlaybackBlocked(false)
  }

  async function startPresentation(mode: Exclude<PresenterMode, null>) {
    if (!selected) return
    const target = mode === "chapter" ? chapterChunks[0] : selected
    if (!target) return
    if (await activatePresenterSection(target)) setPresenterMode(mode)
  }

  function handlePlaybackEnded() {
    if (presenterMode === "chapter" && chapterSelectedIndex < chapterChunks.length - 1) {
      void activatePresenterSection(chapterChunks[chapterSelectedIndex + 1])
      return
    }
    setQuestionBreak(true)
  }

  async function startBlockedPlayback() {
    const audio = presenterAudioRef.current
    if (!audio) return
    try {
      await audio.play()
      setPlaybackBlocked(false)
    } catch {
      setPlaybackBlocked(true)
    }
  }

  async function enterFullscreen() {
    await presenterRef.current?.requestFullscreen?.().catch(() => undefined)
  }

  if (authLoading || !authenticated || !canView) {
    return <div className="spc-loading">Loading...</div>
  }

  const offlineLabel =
    offlineState === "ready"
      ? `READY OFFLINE${offlineProgress.bytes ? ` / ${formatBytes(offlineProgress.bytes)}` : ""}`
      : offlineState === "preparing"
        ? `PREPARING ${offlineProgress.complete}/${offlineProgress.total}`
        : offlineState === "checking"
          ? "CHECKING MEDIA"
          : offlineState === "partial"
            ? `OFFLINE ${offlineProgress.complete}/${offlineProgress.total}`
            : offlineState === "unavailable"
              ? "OFFLINE STORAGE UNAVAILABLE"
              : "MEDIA ONLINE"

  return (
    <SpcShell title="SPC README">
      {error ? <div className="spc-alert is-error">{error}</div> : null}
      {message ? <div className="spc-alert">{message}</div> : null}

      <section className="spc-panel spc-readme-panel">
        <header className="spc-readme-toolbar">
          <div>
            <strong>INCORPORATE AI INTO TRADING</strong>
            <span>INTERMEDIATE / {activeChapter || "NO CHAPTER"}</span>
          </div>
          <div className="spc-readme-session-status">
            <span className={online ? "is-online" : "is-offline"}>{online ? "ONLINE" : "OFFLINE"}</span>
            <span className={offlineState === "ready" ? "is-ready" : ""}>{offlineLabel}</span>
          </div>
          <div className="spc-readme-toolbar-actions">
            <button type="button" onClick={() => void prepareOffline()} disabled={offlineState === "preparing"}>
              PREPARE OFFLINE
            </button>
            <button type="button" onClick={() => void startPresentation("manual")} disabled={!selected || presenterTransitioning}>
              PRESENT
            </button>
            <button type="button" className="is-primary" onClick={() => void startPresentation("chapter")} disabled={chapterChunks.length === 0 || presenterTransitioning}>
              PLAY CHAPTER
            </button>
            {canEdit ? (
              <button type="button" className={editing ? "is-active" : ""} onClick={() => setEditing((current) => !current)} disabled={!selected}>
                {editing ? "CLOSE EDITOR" : "EDIT"}
              </button>
            ) : null}
          </div>
        </header>

        <nav className="spc-readme-chapter-tabs" role="tablist" aria-label="Presentation chapters">
          {chapterLabels.map((chapterLabel) => (
            <button
              type="button"
              role="tab"
              aria-selected={chapterLabel === activeChapter}
              className={chapterLabel === activeChapter ? "is-active" : ""}
              onClick={() => selectChapter(chapterLabel)}
              key={chapterLabel}
            >
              {chapterLabel}
            </button>
          ))}
        </nav>

        <div className={`spc-readme-workspace${editing ? " is-editing" : ""}`}>
          <nav className="spc-readme-chunk-list" aria-label="Presentation sections">
            <div className="spc-readme-chunk-list-header">
              <span>SECTIONS</span>
              {canEdit ? <button type="button" onClick={() => void addChunk()} disabled={saving}>ADD</button> : null}
            </div>
            {loading ? <p className="spc-readme-empty">Loading...</p> : null}
            {chapterChunks.map((chunk, index) => (
              <button
                type="button"
                className={chunk.id === selected?.id ? "is-active" : ""}
                onClick={() => setSelectedId(chunk.id)}
                key={chunk.id}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span><small>{chunk.sectionLabel}</small><strong>{chunk.title}</strong></span>
                <span><small>{formatDuration(chunk.durationSeconds)}</small>{chunk.status === "draft" ? <i>DRAFT</i> : null}</span>
              </button>
            ))}
            {!loading && chapterChunks.length === 0 ? <p className="spc-readme-empty">No presentation sections.</p> : null}
          </nav>

          <main className="spc-readme-stage-pane">
            {selected ? (
              <>
                <div className="spc-readme-stage-heading">
                  <div><span>{selected.sectionLabel}</span><h1>{selected.title}</h1></div>
                  <span>{formatDuration(selected.durationSeconds)}</span>
                </div>
                <div className="spc-readme-stage">
                  {selectedMedia.video ? (
                    <PresentationMedia
                      title={selected.title}
                      videoSrc={selectedMedia.video}
                      videoMimeType={selected.videoMimeType}
                      narrationSrc={selectedMedia.narration}
                      narrationMimeType={selected.narrationMimeType}
                      narrationLabel={selected.narrationIsAi ? "AI-GENERATED VOICE" : "NARRATION"}
                    />
                  ) : (
                    <PresentationMotionScene
                      scene={selected.visualKind}
                      title={selected.title}
                      keyPoints={selected.keyPoints}
                    />
                  )}
                </div>
                {!selectedMedia.video && selectedMedia.narration ? (
                  <div className="spc-readme-motion-audio"><span>{selected.narrationIsAi ? "AI-GENERATED VOICE" : "NARRATION"}</span><audio controls src={selectedMedia.narration} /></div>
                ) : null}
                <p className="spc-readme-summary">{selected.summary}</p>
              </>
            ) : (
              <div className="spc-readme-empty-stage">No presentation content.</div>
            )}
          </main>

          {selected && editing && draft ? (
            <aside className="spc-readme-editor" aria-label="Edit presentation section">
              <div className="spc-readme-editor-header"><strong>EDIT SECTION</strong><span>REV {selected.revision}</span></div>
              <label><span>CHAPTER</span><input value={draft.chapterLabel} onChange={(event) => setDraft({ ...draft, chapterLabel: event.target.value })} /></label>
              <label><span>SECTION</span><input value={draft.sectionLabel} onChange={(event) => setDraft({ ...draft, sectionLabel: event.target.value })} /></label>
              <label><span>TITLE</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
              <label><span>SUMMARY</span><textarea rows={3} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
              <section className="spc-readme-video-copy" aria-label="Video text">
                <header><strong>VIDEO TEXT</strong><span>USED FOR THE NEXT VIDEO RENDER</span></header>
                {draft.visualCopy.length > 0 ? draft.visualCopy.map((item) => (
                  <label key={item.id}>
                    <span>{item.label}</span>
                    <textarea
                      rows={2}
                      value={item.text}
                      onChange={(event) => setDraft({
                        ...draft,
                        visualCopy: draft.visualCopy.map((entry) => (
                          entry.id === item.id ? { ...entry, text: event.target.value } : entry
                        )),
                      })}
                    />
                  </label>
                )) : <p>NO VIDEO TEXT HAS BEEN DEFINED FOR THIS SECTION.</p>}
              </section>
              <label><span>KEY POINTS / ONE PER LINE</span><textarea rows={5} value={draft.keyPoints} onChange={(event) => setDraft({ ...draft, keyPoints: event.target.value })} /></label>
              <label><span>NARRATION SCRIPT</span><textarea rows={9} value={draft.narration} onChange={(event) => setDraft({ ...draft, narration: event.target.value })} /></label>
              <label><span>Q&amp;A PROMPT</span><textarea rows={3} value={draft.questionPrompt} onChange={(event) => setDraft({ ...draft, questionPrompt: event.target.value })} /></label>
              <div className="spc-readme-editor-row">
                <label><span>SCENE</span><select value={draft.visualKind} onChange={(event) => setDraft({ ...draft, visualKind: event.target.value })}>
                  <option value="chapter-intro">CHAPTER INTRO</option>
                  <option value="daily-pressure">DAILY PRESSURE</option>
                  <option value="varied-formats">VARIED FORMATS</option>
                  <option value="whatsapp-load">WHATSAPP LOAD</option>
                  <option value="prompt-structure">PROMPT STRUCTURE</option>
                  <option value="live-prompt">LIVE PROMPT</option>
                  <option value="ai-response">AI RESPONSE</option>
                  <option value="human-review">HUMAN REVIEW</option>
                  <option value="chapter-takeaway">TAKEAWAY</option>
                  <option value="video">VIDEO</option>
                </select></label>
                <label><span>SECONDS</span><input inputMode="numeric" value={draft.durationSeconds} onChange={(event) => setDraft({ ...draft, durationSeconds: event.target.value.replace(/\D/g, "") })} /></label>
                <label><span>STATUS</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value === "draft" ? "draft" : "published" })}><option value="published">PUBLISHED</option><option value="draft">DRAFT</option></select></label>
              </div>
              <div className="spc-readme-media-inputs">
                <label><span>VIDEO {selected.videoBytes ? `/ ${formatBytes(selected.videoBytes)}` : ""}</span><input type="file" accept="video/mp4,video/webm" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadMedia("video", file); event.currentTarget.value = "" }} /></label>
                <label><span>NARRATION {selected.narrationBytes ? `/ ${formatBytes(selected.narrationBytes)}` : ""}</span><input type="file" accept="audio/*" disabled={Boolean(uploading)} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadMedia("narration", file); event.currentTarget.value = "" }} /></label>
              </div>
              {uploading ? <p className="spc-readme-upload-status">UPLOADING {uploading.toUpperCase()}...</p> : null}
              <div className="spc-readme-order-actions">
                <button type="button" onClick={() => void moveChunk("earlier")} disabled={saving || chapterSelectedIndex <= 0}>EARLIER</button>
                <button type="button" onClick={() => void moveChunk("later")} disabled={saving || chapterSelectedIndex >= chapterChunks.length - 1}>LATER</button>
              </div>
              <div className="spc-readme-editor-actions">
                <button type="button" onClick={() => { setDraft(chunkDraft(selected)); setEditing(false) }} disabled={saving}>CANCEL</button>
                <button type="button" className="is-danger" onClick={() => void deleteChunk()} disabled={saving}>DELETE</button>
                <button type="button" className="is-primary" onClick={() => void saveDraft()} disabled={saving}>{saving ? "SAVING..." : "SAVE"}</button>
              </div>
            </aside>
          ) : selected ? (
            <aside className="spc-readme-reference">
              <div className="spc-readme-reference-tabs" role="tablist" aria-label="Section reference">
                <button type="button" className={referenceTab === "points" ? "is-active" : ""} onClick={() => setReferenceTab("points")}>KEY POINTS</button>
                <button type="button" className={referenceTab === "script" ? "is-active" : ""} onClick={() => setReferenceTab("script")}>SCRIPT</button>
                <button type="button" className={referenceTab === "questions" ? "is-active" : ""} onClick={() => setReferenceTab("questions")}>Q&amp;A</button>
              </div>
              {referenceTab === "points" ? <ol className="spc-readme-key-points">{selected.keyPoints.map((point) => <li key={point}>{point}</li>)}</ol> : null}
              {referenceTab === "script" ? <div className="spc-readme-script">{selected.narration}</div> : null}
              {referenceTab === "questions" ? <div className="spc-readme-question"><span>AUDIENCE BREAK</span><strong>{selected.questionPrompt || "Questions?"}</strong></div> : null}
            </aside>
          ) : null}
        </div>
      </section>

      {presenterMode && selected ? (
        <div className="spc-readme-presenter" ref={presenterRef} role="dialog" aria-modal="true" aria-label="Presentation mode">
          <header>
            <div>
              <span>{activeChapter} / {String(chapterSelectedIndex + 1).padStart(2, "0")} OF {String(chapterChunks.length).padStart(2, "0")}</span>
              <strong>{selected.title}</strong>
            </div>
            <div>
              {presenterMode === "chapter" ? <span className="spc-readme-presenter-mode">CONTINUOUS</span> : null}
              <button type="button" onClick={() => void enterFullscreen()}>FULL SCREEN</button>
              <button type="button" onClick={closePresentation}>CLOSE</button>
            </div>
          </header>
          <main>
            {questionBreak ? (
              <div className="spc-readme-presenter-question">
                <span>{presenterMode === "chapter" ? "CHAPTER COMPLETE" : "Q&A BREAK"}</span>
                <strong>{selected.questionPrompt || "Questions?"}</strong>
              </div>
            ) : selectedMedia.video ? (
              <PresentationMedia
                title={selected.title}
                videoSrc={selectedMedia.video}
                videoMimeType={selected.videoMimeType}
                narrationSrc={selectedMedia.narration}
                narrationMimeType={selected.narrationMimeType}
                narrationLabel={selected.narrationIsAi ? "AI-GENERATED VOICE" : "NARRATION"}
                autoPlay
                onEnded={handlePlaybackEnded}
                startLabel={presenterMode === "chapter" ? "START CHAPTER" : "START PRESENTATION"}
              />
            ) : (
              <PresentationMotionScene scene={selected.visualKind} title={selected.title} keyPoints={selected.keyPoints} />
            )}
            {playbackBlocked ? (
              <button type="button" className="spc-readme-playback-start" onClick={() => void startBlockedPlayback()}>
                START {presenterMode === "chapter" ? "CHAPTER" : "PRESENTATION"}
              </button>
            ) : null}
          </main>
          {!questionBreak && !selectedMedia.video && selectedMedia.narration ? <div className="spc-readme-presenter-audio"><span>{selected.narrationIsAi ? "AI-GENERATED VOICE" : "NARRATION"}</span><audio ref={presenterAudioRef} controls autoPlay src={selectedMedia.narration} onEnded={handlePlaybackEnded} /></div> : null}
          <footer>
            <button type="button" onClick={showPreviousSection} disabled={chapterSelectedIndex <= 0 || presenterTransitioning}>PREVIOUS</button>
            {presenterMode === "chapter" ? (
              <button type="button" className={questionBreak ? "is-active" : ""} onClick={() => void startPresentation("chapter")} disabled={presenterTransitioning}>RESTART CHAPTER</button>
            ) : (
              <button type="button" className={questionBreak ? "is-active" : ""} onClick={() => setQuestionBreak((current) => !current)}>{questionBreak ? "RETURN" : "Q&A"}</button>
            )}
            <button type="button" className="is-primary" onClick={showNextSection} disabled={chapterSelectedIndex >= chapterChunks.length - 1 || presenterTransitioning}>NEXT SECTION</button>
          </footer>
        </div>
      ) : null}
    </SpcShell>
  )
}
