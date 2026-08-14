import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../store'
import { IconCheck, IconExpand, IconPlay, IconSettings, IconVolume } from './Icons'
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
  const qualityMenuRef = useRef<HTMLDivElement>(null)
  const scrubbingRef = useRef(false)
  const resumeAfterScrubRef = useRef(false)
  const resumeAfterQualityRef = useRef<{ time: number; playing: boolean } | null>(null)
  const [playing, setPlaying] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrubValue, setScrubValue] = useState<number | null>(null)
  const [activeSrc, setActiveSrc] = useState(src)
  const [quality, setQuality] = useState<VideoQuality | 'auto'>('auto')
  const [qualityBusy, setQualityBusy] = useState(false)
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false)
  const [sourceError, setSourceError] = useState(false)
  const qualitySignature = qualities.join('|')

  useEffect(() => {
    let cancelled = false
    const preferred = playbackQuality !== 'auto' && qualities.includes(playbackQuality)
      ? playbackQuality
      : 'auto'
    setQuality(preferred)
    setTime(0)
    setDuration(0)
    setScrubValue(null)
    setSourceError(false)
    setQualityBusy(true)
    void magpie
      .getMediaPlaybackUrl(postId, mediaIndex, 'video', preferred)
      .then((url) => {
        if (!cancelled) setActiveSrc(url || src)
      })
      .catch(() => {
        if (!cancelled) {
          setActiveSrc(src)
          setSourceError(!src)
        }
      })
      .finally(() => {
        if (!cancelled) setQualityBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [mediaIndex, playbackQuality, postId, qualitySignature, src])

  useEffect(() => {
    if (!qualityMenuOpen) return
    const close = (event: PointerEvent): void => {
      if (!qualityMenuRef.current?.contains(event.target as Node)) setQualityMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [qualityMenuOpen])

  /* Le volume du store est la source de vérité : on le pousse dans l'élément à chaque
     changement, y compris quand un nouveau clip est monté. */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.volume = volume
    el.muted = muted
  }, [volume, muted, activeSrc])

  const chooseQuality = async (next: VideoQuality | 'auto'): Promise<void> => {
    const current = ref.current
    resumeAfterQualityRef.current = current
      ? { time: current.currentTime, playing: !current.paused }
      : null
    setQuality(next)
    setQualityMenuOpen(false)
    setQualityBusy(true)
    setSourceError(false)
    try {
      const url = await magpie.getMediaPlaybackUrl(postId, mediaIndex, 'video', next)
      setActiveSrc(url || src)
    } catch {
      setSourceError(true)
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
        src={activeSrc || undefined}
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
        onLoadedMetadata={(e) => {
          const video = e.currentTarget
          setDuration(video.duration)
          const resume = resumeAfterQualityRef.current
          if (resume) {
            video.currentTime = Math.min(resume.time, Math.max(0, video.duration - 0.08))
            setTime(video.currentTime)
            if (resume.playing) void video.play().catch(() => setPlaying(false))
            resumeAfterQualityRef.current = null
          }
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onEnded={(e) => {
          e.currentTarget.currentTime = 0
          setTime(0)
          void e.currentTarget.play().catch(() => setPlaying(false))
        }}
        onError={() => {
          if (src && activeSrc !== src) {
            setQuality('auto')
            setActiveSrc(src)
            setSourceError(false)
          } else {
            setSourceError(true)
          }
        }}
      />

      {sourceError ? <div className="player__error">{t('player.streamError')}</div> : null}

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

        {qualities.length > 0 ? (
          <div className="player__quality" ref={qualityMenuRef}>
            {qualityMenuOpen ? (
              <div className="player__quality-popover" role="menu" aria-label={t('player.quality')}>
                <span className="player__quality-title">{t('player.quality')}</span>
                {(['auto', ...qualities] as Array<VideoQuality | 'auto'>).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="menuitemradio"
                    aria-checked={quality === item}
                    className={quality === item ? 'is-active' : ''}
                    onClick={() => void chooseQuality(item)}
                  >
                    <span>{t(`quality.${item}` as Parameters<typeof t>[0])}</span>
                    {quality === item ? <IconCheck size={13} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              type="button"
              className={`player__btn ${qualityMenuOpen ? 'is-active' : ''} ${qualityBusy ? 'is-busy' : ''}`}
              disabled={qualityBusy}
              onClick={() => setQualityMenuOpen((open) => !open)}
              aria-label={t('player.quality')}
              aria-expanded={qualityMenuOpen}
            >
              <IconSettings size={15} />
            </button>
          </div>
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
