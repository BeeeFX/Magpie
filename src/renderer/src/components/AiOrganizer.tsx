import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiCollectionApplyResult,
  AiCollectionPlan,
  AiCollectionSuggestion,
  OrganizerProgress,
  Post
} from '@shared/types'
import { redistributeOrganizerRoutes } from '@shared/organizer'
import { magpie, magpieEvents } from '../bridge'
import { displayName } from '../format'
import { useStore, useT } from '../store'
import { IconChevronRight, IconClose } from './Icons'
import { PlatformIcon } from './PlatformIcon'

interface Props {
  open: boolean
  onClose(): void
}

interface EditableSuggestion extends AiCollectionSuggestion {
  included: boolean
}

const PREVIEW_LIMIT = 12

export function AiOrganizer({ open, onClose }: Props): React.JSX.Element | null {
  const t = useT()
  const refresh = useStore((state) => state.refresh)
  const loadSettings = useStore((state) => state.loadSettings)
  const autoOrganizeEnabled = useStore((state) => state.autoOrganizeEnabled)
  const [organizerProgress, setOrganizerProgress] = useState<OrganizerProgress | null>(null)
  const [phase, setPhase] = useState<'intro' | 'loading' | 'review' | 'applying' | 'done'>('intro')
  const [plan, setPlan] = useState<AiCollectionPlan | null>(null)
  const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AiCollectionApplyResult | null>(null)
  const [rememberChoices, setRememberChoices] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewPosts, setPreviewPosts] = useState<Post[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const previewRequestRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setPhase('intro')
    setPlan(null)
    setSuggestions([])
    setError(null)
    setResult(null)
    setRememberChoices(autoOrganizeEnabled)
    setPreviewId(null)
    setPreviewPosts([])
    setPreviewLoading(false)
    setPreviewError(false)
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

  const redistributed = useMemo(
    () => redistributeOrganizerRoutes(suggestions, plan?.routes ?? []),
    [plan?.routes, suggestions]
  )
  const selected = useMemo(
    () =>
      suggestions
        .filter((suggestion) => suggestion.included && suggestion.name.trim())
        .map((suggestion) => ({
          ...suggestion,
          postIds: redistributed.get(suggestion.id) ?? []
        })),
    [redistributed, suggestions]
  )
  const selectedVideos = useMemo(
    () => new Set(selected.flatMap((suggestion) => suggestion.postIds)).size,
    [selected]
  )
  const assignedPostIds = useMemo(
    () => new Set(selected.flatMap((suggestion) => suggestion.postIds)),
    [selected]
  )
  const unassignedVideos = Math.max(0, (plan?.analysedVideos ?? 0) - selectedVideos)

  if (!open) return null

  const analyse = async (): Promise<void> => {
    setPhase('loading')
    setError(null)
    try {
      const next = await magpie.proposeAiCollections()
      setPlan(next)
      setSuggestions(next.suggestions.map((suggestion) => ({ ...suggestion, included: true })))
      setPreviewId(null)
      setPhase('review')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('intro')
    }
  }

  const merge = (sourceId: string, targetId: string): void => {
    if (!targetId || sourceId === targetId) return
    setPreviewId(null)
    setPreviewPosts([])
    setSuggestions((current) => {
      const source = current.find((item) => item.id === sourceId)
      if (!source) return current
      return current
        .filter((item) => item.id !== sourceId)
        .map((item) =>
          item.id === targetId
            ? {
                ...item,
                postIds: [...new Set([...item.postIds, ...source.postIds])],
                ruleKeys: [...new Set([...item.ruleKeys, ...source.ruleKeys])]
              }
            : item
        )
    })
  }

  const setIncluded = (suggestionId: string, included: boolean): void => {
    previewRequestRef.current += 1
    setPreviewId(null)
    setPreviewPosts([])
    setPreviewLoading(false)
    setPreviewError(false)
    setSuggestions((current) =>
      current.map((item) => (item.id === suggestionId ? { ...item, included } : item))
    )
  }

  const togglePreview = async (suggestion: EditableSuggestion): Promise<void> => {
    if (previewId === suggestion.id) {
      previewRequestRef.current += 1
      setPreviewId(null)
      setPreviewPosts([])
      setPreviewLoading(false)
      setPreviewError(false)
      return
    }

    const request = ++previewRequestRef.current
    setPreviewId(suggestion.id)
    setPreviewPosts([])
    setPreviewLoading(true)
    setPreviewError(false)
    try {
      const posts = await magpie.getPostsByIds(suggestion.postIds.slice(0, PREVIEW_LIMIT))
      if (previewRequestRef.current === request) setPreviewPosts(posts)
    } catch {
      if (previewRequestRef.current === request) setPreviewError(true)
    } finally {
      if (previewRequestRef.current === request) setPreviewLoading(false)
    }
  }

  const apply = async (): Promise<void> => {
    setPhase('applying')
    setError(null)
    try {
      const applied = await magpie.applyAiCollections(
        selected.map((suggestion) => ({
          name: suggestion.name.trim(),
          postIds: suggestion.postIds,
          ruleKeys: suggestion.ruleKeys
        })),
        {
          remember: rememberChoices,
          ignoredRuleKeys: rememberChoices
            ? suggestions
                .filter((suggestion) => !suggestion.included)
                .flatMap((suggestion) => suggestion.ruleKeys)
            : []
        }
      )
      setResult(applied)
      await loadSettings()
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
                <div><strong>{unassignedVideos}</strong><span>{t('organizer.unassigned')}</span></div>
              </div>
              <p className="organizer-review-hint">{t('organizer.reviewHint')}</p>
              <div className="organizer-memory">
                <div>
                  <strong>{t('organizer.rememberTitle')}</strong>
                  <span>{t('organizer.rememberHint')}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={rememberChoices}
                  className={`switch ${rememberChoices ? 'is-on' : ''}`}
                  disabled={phase === 'applying'}
                  onClick={() => setRememberChoices((value) => !value)}
                >
                  <span className="switch__knob" />
                </button>
              </div>
              <div className="organizer-list">
                {suggestions.map((suggestion) => {
                  const effectivePostIds = suggestion.included
                    ? redistributed.get(suggestion.id) ?? []
                    : suggestion.postIds
                  const previewSuggestion = { ...suggestion, postIds: effectivePostIds }
                  const redistributedCount = suggestion.postIds.filter((postId) =>
                    assignedPostIds.has(postId)
                  ).length
                  const leftUnassigned = suggestion.postIds.length - redistributedCount
                  return (
                  <article className={`organizer-category ${suggestion.included ? '' : 'is-excluded'}`} key={suggestion.id}>
                    <label className="organizer-category__toggle">
                      <input
                        type="checkbox"
                        checked={suggestion.included}
                        disabled={phase === 'applying'}
                        onChange={(event) => setIncluded(suggestion.id, event.target.checked)}
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
                      {!suggestion.included ? (
                        <p className="organizer-category__redistribution">
                          {t('organizer.redistribution', {
                            redistributed: redistributedCount,
                            unassigned: leftUnassigned
                          })}
                        </p>
                      ) : null}
                    </div>
                    <div className="organizer-category__side">
                      <button
                        type="button"
                        className="organizer-category__preview-trigger"
                        disabled={phase === 'applying'}
                        aria-expanded={previewId === suggestion.id}
                        aria-controls={`organizer-preview-${suggestion.id}`}
                        onClick={() => void togglePreview(previewSuggestion)}
                      >
                        <span className="organizer-category__count">
                          <strong>{effectivePostIds.length}</strong>
                          <span>{t('organizer.items')}</span>
                        </span>
                        <span className="organizer-category__preview-label">
                          {t(previewId === suggestion.id ? 'organizer.hidePreview' : 'organizer.preview')}
                          <IconChevronRight size={13} />
                        </span>
                      </button>
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
                    {previewId === suggestion.id ? (
                      <div
                        className="organizer-category__preview"
                        id={`organizer-preview-${suggestion.id}`}
                      >
                        {previewLoading ? (
                          <div className="organizer-category__preview-state" aria-live="polite">
                            <span className="spinner" />
                            <span>{t('organizer.previewLoading')}</span>
                          </div>
                        ) : previewError || previewPosts.length === 0 ? (
                          <div className="organizer-category__preview-state">
                            {t(previewError ? 'organizer.previewError' : 'organizer.previewEmpty')}
                          </div>
                        ) : (
                          <>
                            <div className="organizer-category__preview-grid">
                              {previewPosts.map((post) => {
                                const thumb =
                                  post.media.find((media) => media.kind === 'video')?.thumbUrl ??
                                  post.thumbUrl
                                return (
                                  <button
                                    type="button"
                                    className="organizer-preview-card"
                                    key={post.id}
                                    title={t('organizer.openOriginal')}
                                    onClick={() => void magpie.openExternal(post.url)}
                                  >
                                    <span className="organizer-preview-card__media">
                                      {thumb ? (
                                        <img src={thumb} alt="" loading="lazy" />
                                      ) : (
                                        <PlatformIcon platform={post.platform} size={22} coloured />
                                      )}
                                    </span>
                                    <span className="organizer-preview-card__meta">
                                      <PlatformIcon platform={post.platform} size={12} coloured />
                                      <span>{displayName(post)}</span>
                                    </span>
                                    {post.text ? <span className="organizer-preview-card__text">{post.text}</span> : null}
                                  </button>
                                )
                              })}
                            </div>
                            {effectivePostIds.length > previewPosts.length ? (
                              <span className="organizer-category__preview-more">
                                {t('organizer.previewMore', {
                                  count: effectivePostIds.length - previewPosts.length
                                })}
                              </span>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </article>
                  )
                })}
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
              {rememberChoices ? <p>{t('organizer.rememberDone')}</p> : null}
              <button type="button" className="btn btn--primary" onClick={onClose}>{t('organizer.close')}</button>
            </div>
          ) : null}
        </div>

        {phase === 'review' || phase === 'applying' ? (
          <footer className="modal__foot organizer-foot">
            <span>{t(selected.length === 1 ? 'organizer.selectionOne' : 'organizer.selection', {
              categories: selected.length,
              videos: selectedVideos
            })}</span>
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
