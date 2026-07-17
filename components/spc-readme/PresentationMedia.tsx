"use client"

import { useEffect, useRef, useState } from "react"

type PresentationMediaProps = {
  title: string
  videoSrc: string
  videoMimeType?: string | null
  narrationSrc?: string | null
  narrationMimeType?: string | null
  narrationLabel?: string
  videoHasEmbeddedAudio?: boolean
  autoPlay?: boolean
  onEnded?: () => void
  startLabel?: string
}

export function PresentationMedia({
  title,
  videoSrc,
  narrationSrc,
  narrationLabel = "NARRATION",
  videoHasEmbeddedAudio = false,
  autoPlay = false,
  onEnded,
  startLabel = "START VIDEO",
}: PresentationMediaProps) {
  const mediaRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const narrationRef = useRef<HTMLAudioElement>(null)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false)
  const hasSeparateNarration = Boolean(narrationSrc) && !videoHasEmbeddedAudio
  const isExpanded = isFullscreen || isFallbackFullscreen

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === mediaRef.current)
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (!isFallbackFullscreen) return
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFallbackFullscreen(false)
    }
    document.body.style.overflow = "hidden"
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [isFallbackFullscreen])

  useEffect(() => {
    if (!autoPlay) return
    const media = hasSeparateNarration ? narrationRef.current : videoRef.current
    if (!media) return

    let cancelled = false
    void media.play()
      .then(() => {
        if (!cancelled) setPlaybackBlocked(false)
      })
      .catch(() => {
        if (!cancelled) setPlaybackBlocked(true)
      })
    return () => {
      cancelled = true
    }
  }, [autoPlay, hasSeparateNarration, narrationSrc, videoSrc])

  function syncVideoToNarration(audio: HTMLAudioElement) {
    const video = videoRef.current
    if (!video) return
    if (Math.abs(video.currentTime - audio.currentTime) > 0.18) {
      video.currentTime = audio.currentTime
    }
  }

  async function handleNarrationPlay(audio: HTMLAudioElement) {
    setPlaybackBlocked(false)
    const video = videoRef.current
    if (!video) return
    syncVideoToNarration(audio)
    await video.play().catch(() => undefined)
  }

  async function startBlockedPlayback() {
    const media = hasSeparateNarration ? narrationRef.current : videoRef.current
    if (!media) return
    try {
      await media.play()
      setPlaybackBlocked(false)
    } catch {
      setPlaybackBlocked(true)
    }
  }

  async function toggleFullscreen() {
    if (isFallbackFullscreen) {
      setIsFallbackFullscreen(false)
      return
    }
    if (document.fullscreenElement === mediaRef.current) {
      await document.exitFullscreen()
      return
    }
    try {
      await mediaRef.current?.requestFullscreen()
    } catch {
      setIsFallbackFullscreen(true)
    }
  }

  return (
    <div className={`spc-readme-media${isFallbackFullscreen ? " is-expanded" : ""}`} ref={mediaRef}>
      <button
        type="button"
        className="spc-readme-media-fullscreen"
        onClick={() => void toggleFullscreen()}
        aria-label={isExpanded ? "Exit full screen" : "View full screen"}
        aria-pressed={isExpanded}
        title={isExpanded ? "Exit full screen" : "Full screen"}
      >
        <span aria-hidden="true">⛶</span>
      </button>
      <video
        ref={videoRef}
        src={videoSrc}
        controls={!hasSeparateNarration}
        autoPlay={autoPlay && !hasSeparateNarration}
        muted={hasSeparateNarration}
        playsInline
        preload={autoPlay ? "auto" : "metadata"}
        aria-label={title}
        onPlay={() => {
          if (!hasSeparateNarration) setPlaybackBlocked(false)
        }}
        onEnded={hasSeparateNarration ? undefined : onEnded}
      />
      {hasSeparateNarration && narrationSrc ? (
        <div className="spc-readme-narration-control">
          <span>{narrationLabel}</span>
          <audio
            ref={narrationRef}
            src={narrationSrc}
            controls
            autoPlay={autoPlay}
            preload={autoPlay ? "auto" : "metadata"}
            onPlay={(event) => void handleNarrationPlay(event.currentTarget)}
            onPause={() => videoRef.current?.pause()}
            onSeeking={(event) => syncVideoToNarration(event.currentTarget)}
            onTimeUpdate={(event) => syncVideoToNarration(event.currentTarget)}
            onEnded={() => {
              videoRef.current?.pause()
              onEnded?.()
            }}
          />
        </div>
      ) : null}
      {playbackBlocked ? (
        <button type="button" className="spc-readme-playback-start" onClick={() => void startBlockedPlayback()}>
          {startLabel}
        </button>
      ) : null}
    </div>
  )
}
