import { useCallback, useEffect, useState } from 'react'
import { magpie } from '../bridge'
import { useT } from '../store'
import { report, setPerfEnabled, summary, type PerfSummary } from '../perf'

/**
 * Le relevé du dessin, à l'écran.
 *
 * Trois tentatives d'optimisation ont visé à côté faute de mesure : la résolution du calque, le
 * découpage en tranches, la coalescence des dessins. Chacune reposait sur un raisonnement juste
 * et sur une hypothèse fausse quant à *où* passait le temps. Ce panneau remplace le raisonnement
 * par un chiffre — et par un bouton qui le copie, pour qu'un relevé se lise en texte plutôt que
 * se devine sur une capture d'écran.
 *
 * `Ctrl` + `Maj` + `P` l'ouvre. Il n'est nulle part ailleurs dans l'interface : c'est un outil de
 * mise au point, pas une fonction.
 */
export function MapPerf(): React.JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState<PerfSummary | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'p') return
      event.preventDefault()
      setOpen((current) => !current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    setPerfEnabled(open)
    if (!open) {
      setNow(null)
      return
    }
    /* Quatre fois par seconde : assez pour suivre un geste, assez peu pour que le panneau ne
       fasse pas partie de ce qu'il mesure. */
    const timer = window.setInterval(() => setNow(summary()), 250)
    return () => {
      window.clearInterval(timer)
      setPerfEnabled(false)
    }
  }, [open])

  const copy = useCallback(() => {
    void magpie.copyToClipboard(report())
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }, [])

  if (!open) return null

  return (
    <div className="map-perf" role="status">
      <header>
        <strong>{t('perf.title')}</strong>
        <button type="button" onClick={copy}>
          {copied ? t('perf.copied') : t('perf.copy')}
        </button>
        <button type="button" onClick={() => setOpen(false)} aria-label={t('perf.close')}>
          ×
        </button>
      </header>
      {now ? (
        <>
          <p className="map-perf__head">
            {now.fps.toFixed(1)}/s · {t('perf.average')} {now.average.toFixed(1)} ms · p95{' '}
            {now.p95.toFixed(1)} · {t('perf.worst')} {now.worst.toFixed(1)}
            {/* Les images au-delà de seize millisecondes sont celles qu'on voit passer. */}
            <span className={now.late > 0 ? 'is-late' : ''}>{` · ${t('perf.late')} ${now.late}`}</span>
          </p>
          <ul>
            {now.parts.map((part) => (
              <li key={part.name}>
                <span>{part.name}</span>
                <span>{part.average.toFixed(2)}</span>
                <span className="map-perf__worst">{part.worst.toFixed(1)}</span>
              </li>
            ))}
          </ul>
          <p className="map-perf__notes">
            {Object.entries(now.notes).map(([key, value]) => `${key}=${value}`).join('  ')}
          </p>
        </>
      ) : (
        <p className="map-perf__head">{t('perf.idle')}</p>
      )}
    </div>
  )
}
