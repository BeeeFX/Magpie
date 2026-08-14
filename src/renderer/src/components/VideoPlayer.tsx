import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../store'
import { IconExpand, IconPlay, IconVolume } from './Icons'
import type { VideoQuality } from '@shared/types'
import { magpie } from '../bridge'

interface Props {
  src: string
  poster?: string
  postId: string
  mediaIndex: number
  qualities: VideoQuality[]
  fullscreen: boolean
  onToggleFullscreen(): Promise<void>
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Lecteur vidéo intégré.
 *
 * Les contrôles natifs varient d'un moteur à l'autre et jurent avec le reste ; surtout,
 * ils repartent au volume par défaut à chaque élément. Ici le **volume et la sourdine sont
 * partagés** : ils vivent dans le store, persistés, et s'appliquent à chaque clip ouvert —
 * on règle une fois, pas à chaque post.
 */
export function VideoPlayer({
  src,
  poster,
  postId,
  mediaIndex,
  qualities,
  fullscreen,
  onToggleFullscreen
}: Props): React.JSX.Element {
  const t = useT()
  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const setVolume = useStore((s) => s.setVolume)
  const setMuted = useStore((s) => s.setMuted)
  const playbackQuality = useStore((s) => s.playbackQuality)

  const ref = useRef<HTMLVideoElement>(null)
  const scrubbingRef = useRef(false)
  const resumeAfterScrubRef = useRef(false)
  const [playing, setPlaying] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrubValue, setScrubValue] = useState<number | null>(null)
  const [activeSrc, setActiveSrc] = useState(src)
  const [quality, setQuality] = useState<VideoQuality | 'auto'>('auto')
  const [qualityBusy, setQualityBusy] = useState(false)

  useEffect(() => {
    setActiveSrc(src)
    setQuality('auto')
    setTime(0)
    setDuration(0)
    setScrubValue(null)
  }, [src])

  useEffect(() => {
    if (playbackQuality === 'auto' || !qualities.includes(playbackQuality)) return
    let cancelled = false
    setQualityBusy(true)
    void magpie
      .cacheVideoQuality(postId, mediaIndex, playbackQuality)
      .then((url) => {
        if (!cancelled) {
          setActiveSrc(url)
          setQuality(playbackQuality)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setQualityBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [mediaIndex, playbackQuality, postId, qualities])

  /* Le volume du store est la source de vérité : on le pousse dans l'élément à chaque
     changement, y compris quand un nouveau clip est monté. */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.volume = volume
    el.muted = muted
  }, [volume, muted, activeSrc])

  const chooseQuality = async (next: VideoQuality | 'auto'): Promise<void> => {
    setQuality(next)
    if (next === 'auto') {
      setActiveSrc(src)
      return
    }
    setQualityBusy(true)
    try {
      setActiveSrc(await magpie.cacheVideoQuality(postId, mediaIndex, next))
    } finally {
      setQualityBusy(false)
    }
  }

  const toggle = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (el.paused) {
      if (el.ended || (Number.isFinite(el.duration) && el.currentTime >= el.duration - 0.08)) {
        el.currentTime = 0
        setTime(0)
      }
      void el.play().catch(() => setPlaying(false))
    }
    else el.pause()
  }, [])

  const beginScrub = (): void => {
    const el = ref.current
    if (!el) return
    scrubbingRef.current = true
    resumeAfterScrubRef.current = !el.paused
    if (!el.paused) el.pause()
  }

  const seek = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const el = ref.current
    if (!el || !Number.isFinite(duration) || duration <= 0) return
    const value = Number(event.target.value)
    const nextTime = (value / 1000) * duration
    setScrubValue(value)
    setTime(nextTime)
    try {
      el.currentTime = nextTime
    } catch {
      // La prochaine requête par plage reprendra dès que les métadonnées seront prêtes.
    }
  }

  const endScrub = (): void => {
    const el = ref.current
    if (!el || !scrubbingRef.current) return
    scrubbingRef.current = false
    setScrubValue(null)
    if (resumeAfterScrubRef.current) void el.play().catch(() => setPlaying(false))
    resumeAfterScrubRef.current = false
  }

  return (
    <div className="player">
      <video
        ref={ref}
        src={activeSrc}
        poster={poster}
        className="player__video"
        autoPlay
        playsInline
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          if (!scrubbingRef.current) setTime(e.currentTarget.currentTime)
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onEnded={(e) => {
          e.currentTarget.currentTime = 0
          setTime(0)
          void e.currentTarget.play().catch(() => setPlaying(false))
        }}
      />

      <div className="player__bar">
        <button type="button" className="player__btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <span className="player__pause" /> : <IconPlay size={14} />}
        </button>

        <span className="player__time">{formatClock(time)}</span>

        <input
          className="player__seek"
          type="range"
          min={0}
          max={1000}
          value={scrubValue ?? (duration > 0 ? Math.round((time / duration) * 1000) : 0)}
          onPointerDown={beginScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
              beginScrub()
            }
          }}
          onKeyUp={endScrub}
          onBlur={endScrub}
          onChange={seek}
          aria-label="Position"
        />

        <span className="player__time">{formatClock(duration)}</span>

        {qualities.length > 1 ? (
          <select
            className="player__quality"
            value={quality}
            disabled={qualityBusy}
            onChange={(event) =>
              void chooseQuality(event.target.value as VideoQuality | 'auto')
            }
            aria-label={t('player.quality')}
          >
            <option value="auto">{t('quality.auto')}</option>
            {qualities.map((item) => (
              <option key={item} value={item}>
                {t(`quality.${item}` as Parameters<typeof t>[0])}
              </option>
            ))}
          </select>
        ) : null}

        <div className="player__volume">
          <button
            type="button"
            className="player__btn"
            onClick={() => setMuted(!muted)}
            aria-label="Volume"
          >
            <IconVolume size={15} waves={!muted && volume > 0} />
          </button>
          <input
            className="player__volume-slider"
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : Math.round(volume * 100)}
            onChange={(e) => {
              const next = Number(e.target.value) / 100
              setVolume(next)
              if (next > 0 && muted) setMuted(false)
            }}
            aria-label="Volume"
          />
        </div>

        <button
          type="button"
          className={`player__btn ${fullscreen ? 'is-active' : ''}`}
          onClick={() => void onToggleFullscreen().catch(() => {})}
          aria-label={t('detail.fullscreen')}
          aria-pressed={fullscreen}
        >
          <IconExpand size={15} />
        </button>
      </div>
    </div>
  )
}
