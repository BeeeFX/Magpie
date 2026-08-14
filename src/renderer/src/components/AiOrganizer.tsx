import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiCollectionApplyResult,
  AiCollectionPlan,
  AiCollectionSuggestion,
  OrganizerProgress
} from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { useStore, useT } from '../store'
import { IconClose } from './Icons'

interface Props {
  open: boolean
  onClose(): void
}

interface EditableSuggestion extends AiCollectionSuggestion {
  included: boolean
}

export function AiOrganizer({ open, onClose }: Props): React.JSX.Element | null {
  const t = useT()
  const refresh = useStore((state) => state.refresh)
  const [organizerProgress, setOrganizerProgress] = useState<OrganizerProgress | null>(null)
  const [phase, setPhase] = useState<'intro' | 'loading' | 'review' | 'applying' | 'done'>('intro')
  const [plan, setPlan] = useState<AiCollectionPlan | null>(null)
  const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AiCollectionApplyResult | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setPhase('intro')
    setPlan(null)
    setSuggestions([])
    setError(null)
    setResult(null)
    requestAnimationFrame(() => panelRef.current?.focus())
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    return magpieEvents.onOrganizerProgress(setOrganizerProgress)
  }, [open])

  const selected = useMemo(
    () => suggestions.filter((suggestion) => suggestion.included && suggestion.name.trim()),
    [suggestions]
  )
  const selectedVideos = useMemo(
    () => new Set(selected.flatMap((suggestion) => suggestion.postIds)).size,
    [selected]
  )

  if (!open) return null

  const analyse = async (): Promise<void> => {
    setPhase('loading')
    setError(null)
    try {
      const next = await magpie.proposeAiCollections()
      setPlan(next)
      setSuggestions(next.suggestions.map((suggestion) => ({ ...suggestion, included: true })))
      setPhase('review')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('intro')
    }
  }

  const merge = (sourceId: string, targetId: string): void => {
    if (!targetId || sourceId === targetId) return
    setSuggestions((current) => {
      const source = current.find((item) => item.id === sourceId)
      if (!source) return current
      return current
        .filter((item) => item.id !== sourceId)
        .map((item) =>
          item.id === targetId
            ? { ...item, postIds: [...new Set([...item.postIds, ...source.postIds])] }
            : item
        )
    })
  }

  const apply = async (): Promise<void> => {
    setPhase('applying')
    setError(null)
    try {
      const applied = await magpie.applyAiCollections(
        selected.map((suggestion) => ({
          name: suggestion.name.trim(),
          postIds: suggestion.postIds
        }))
      )
      setResult(applied)
      await refresh()
      setPhase('done')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('review')
    }
  }

  return (
    <div className="modal ai-organizer" onMouseDown={onClose}>
      <div
        ref={panelRef}
        className="modal__panel ai-organizer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-organizer-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head">
          <div>
            <h2 id="ai-organizer-title">{t('organizer.title')}</h2>
            <p>{t('organizer.subtitle')}</p>
          </div>
          <button type="button" className="icon-btn-ghost" onClick={onClose} aria-label={t('settings.close')}>
            <IconClose />
          </button>
        </header>

        <div className="modal__body ai-organizer__body">
          {phase === 'intro' ? (
            <div className="organizer-intro">
              <div className="organizer-orbit" aria-hidden="true"><span /><span /><span /></div>
              <h3>{t('organizer.introTitle')}</h3>
              <p>{t('organizer.introText')}</p>
              <ul>
                <li>{t('organizer.stepAnalyse')}</li>
                <li>{t('organizer.stepReview')}</li>
                <li>{t('organizer.stepApply')}</li>
              </ul>
              {error ? <p className="organizer-error">{error}</p> : null}
              <button type="button" className="btn btn--primary" onClick={() => void analyse()}>
                {t('organizer.start')}
              </button>
              <small>{t('organizer.costNote')}</small>
            </div>
          ) : null}

          {phase === 'loading' ? (
            <div className="organizer-loading" aria-live="polite">
              <div className="organizer-spinner" />
              <h3>{t('organizer.working')}</h3>
              <p>
                {organizerProgress?.stage === 'visuals'
                  ? t('organizer.visualProgress', {
                      done: organizerProgress.done,
                      total: organizerProgress.total
                    })
                  : organizerProgress?.stage === 'grouping'
                    ? t('organizer.grouping')
                    : t('organizer.preparing')}
              </p>
              {organizerProgress?.total ? (
                <div className="organizer-progress" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.min(100, (organizerProgress.done / organizerProgress.total) * 100)}%`
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {phase === 'review' || phase === 'applying' ? (
            <>
              <div className="organizer-summary">
                <div><strong>{plan?.analysedVideos ?? 0}</strong><span>{t('organizer.videos')}</span></div>
                <div><strong>{suggestions.length}</strong><span>{t('organizer.categories')}</span></div>
                <div><strong>{plan?.unassignedVideos ?? 0}</strong><span>{t('organizer.unassigned')}</span></div>
              </div>
              <p className="organizer-review-hint">{t('organizer.reviewHint')}</p>
              <div className="organizer-list">
                {suggestions.map((suggestion) => (
                  <article className={`organizer-category ${suggestion.included ? '' : 'is-excluded'}`} key={suggestion.id}>
                    <label className="organizer-category__toggle">
                      <input
                        type="checkbox"
                        checked={suggestion.included}
                        disabled={phase === 'applying'}
                        onChange={(event) =>
                          setSuggestions((current) =>
                            current.map((item) =>
                              item.id === suggestion.id ? { ...item, included: event.target.checked } : item
                            )
                          )
                        }
                      />
                      <span>{t(suggestion.included ? 'organizer.include' : 'organizer.exclude')}</span>
                    </label>
                    <div className="organizer-category__main">
                      <input
                        value={suggestion.name}
                        maxLength={80}
                        disabled={phase === 'applying'}
                        aria-label={t('organizer.categoryName')}
                        onChange={(event) =>
                          setSuggestions((current) =>
                            current.map((item) =>
                              item.id === suggestion.id ? { ...item, name: event.target.value } : item
                            )
                          )
                        }
                      />
                      <p>{suggestion.description}</p>
                    </div>
                    <div className="organizer-category__side">
                      <strong>{suggestion.postIds.length}</strong>
                      <span>{t('organizer.items')}</span>
                      <select
                        value=""
                        disabled={phase === 'applying' || suggestions.length < 2}
                        aria-label={t('organizer.merge')}
                        onChange={(event) => merge(suggestion.id, event.target.value)}
                      >
                        <option value="">{t('organizer.merge')}</option>
                        {suggestions
                          .filter((target) => target.id !== suggestion.id)
                          .map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                      </select>
                    </div>
                  </article>
                ))}
              </div>
              {suggestions.length === 0 ? <p className="organizer-empty">{t('organizer.empty')}</p> : null}
              {error ? <p className="organizer-error">{error}</p> : null}
            </>
          ) : null}

          {phase === 'done' ? (
            <div className="organizer-done">
              <div className="organizer-done__check">✓</div>
              <h3>{t('organizer.doneTitle')}</h3>
              <p>{t('organizer.doneText', {
                collections: result?.collections ?? 0,
                posts: result?.added ?? 0
              })}</p>
              <button type="button" className="btn btn--primary" onClick={onClose}>{t('organizer.close')}</button>
            </div>
          ) : null}
        </div>

        {phase === 'review' || phase === 'applying' ? (
          <footer className="modal__foot organizer-foot">
            <span>{t('organizer.selection', { categories: selected.length, videos: selectedVideos })}</span>
            <div>
              <button type="button" className="btn" disabled={phase === 'applying'} onClick={onClose}>{t('organizer.cancel')}</button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={phase === 'applying' || selected.length === 0}
                onClick={() => void apply()}
              >
                {phase === 'applying' ? t('organizer.applying') : t('organizer.create')}
              </button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  )
}
