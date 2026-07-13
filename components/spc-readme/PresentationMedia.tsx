"use client"

import { useRef } from "react"

type PresentationMediaProps = {
  title: string
  videoSrc: string
  videoMimeType?: string | null
  narrationSrc?: string | null
  narrationMimeType?: string | null
  narrationLabel?: string
  autoPlay?: boolean
  onEnded?: () => void
}

export function PresentationMedia({
  title,
  videoSrc,
  videoMimeType,
  narrationSrc,
  narrationMimeType,
  narrationLabel = "NARRATION",
  autoPlay = false,
  onEnded,
}: PresentationMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasSeparateNarration = Boolean(narrationSrc)

  function syncVideoToNarration(audio: HTMLAudioElement) {
    const video = videoRef.current
    if (!video) return
    if (Math.abs(video.currentTime - audio.currentTime) > 0.18) {
      video.currentTime = audio.currentTime
    }
  }

  async function handleNarrationPlay(audio: HTMLAudioElement) {
    const video = videoRef.current
    if (!video) return
    syncVideoToNarration(audio)
    await video.play().catch(() => undefined)
  }

  return (
    <div className="spc-readme-media">
      <video
        ref={videoRef}
        controls={!hasSeparateNarration}
        autoPlay={autoPlay && !hasSeparateNarration}
        muted={hasSeparateNarration}
        playsInline
        preload="metadata"
        aria-label={title}
        onEnded={hasSeparateNarration ? undefined : onEnded}
      >
        <source src={videoSrc} type={videoMimeType || "video/mp4"} />
      </video>
      {narrationSrc ? (
        <div className="spc-readme-narration-control">
          <span>{narrationLabel}</span>
          <audio
            controls
            autoPlay={autoPlay}
            preload="metadata"
            onPlay={(event) => void handleNarrationPlay(event.currentTarget)}
            onPause={() => videoRef.current?.pause()}
            onSeeking={(event) => syncVideoToNarration(event.currentTarget)}
            onTimeUpdate={(event) => syncVideoToNarration(event.currentTarget)}
            onEnded={() => {
              videoRef.current?.pause()
              onEnded?.()
            }}
          >
            <source src={narrationSrc} type={narrationMimeType || "audio/mpeg"} />
          </audio>
        </div>
      ) : null}
    </div>
  )
}
