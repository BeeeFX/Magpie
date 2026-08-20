import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AiCollectionApplyResult,
  AiCollectionPlan,
  AiCollectionSuggestion,
  OrganizerApplicationSummary,
  OrganizerMap as OrganizerMapData,
  OrganizerProgress,
  OrganizerUndoResult,
  Post
} from '@shared/types'
import { redistributeOrganizerRoutes } from '@shared/organizer'
import { magpie, magpieEvents } from '../bridge'
import { displayName, formatDateTime } from '../format'
import { useStore, useT } from '../store'
import { IconChevronRight, IconClose } from './Icons'
import { MapPostPanel } from './MapPostPanel'
import { OrganizerMap, type ColourMode } from './OrganizerMap'
import type { Vertex } from '../map-boundaries'
import { OrganizerSteps } from './OrganizerSteps'
import { PlatformIcon } from './PlatformIcon'

interface Props {
  open: boolean
  onClose(): void
}

interface EditableSuggestion extends AiCollectionSuggestion {
  included: boolean
  /** Vrai pour un groupe tracé à la main : ses posts sont désignés, pas déduits. */
  pinned?: boolean
}

const PREVIEW_LIMIT = 12

export function AiOrganizer({ open, onClose: requestClose }: Props): React.JSX.Element | null {
  const t = useT()
  const refresh = useStore((state) => state.refresh)
  const loadSettings = useStore((state) => state.loadSettings)
  const autoOrganizeEnabled = useStore((state) => state.autoOrganizeEnabled)
  const stepsRunning = useStore((state) => state.stepsRunning)
  const [organizerProgress, setOrganizerProgress] = useState<OrganizerProgress | null>(null)
  const [phase, setPhase] = useState<'intro' | 'loading' | 'review' | 'applying' | 'done'>('intro')
  const [plan, setPlan] = useState<AiCollectionPlan | null>(null)
  const [suggestions, setSuggestions] = useState<EditableSuggestion[]>([])
  /** Dernière fusion, pour pouvoir la défaire. Une seule profondeur suffit : au-delà, on
   *  relance l'analyse. */
  const [lastMerge, setLastMerge] = useState<{
    before: EditableSuggestion[]
    sourceName: string
    targetName: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  /* Une préparation peut durer des heures. La fermer ne doit ni tout perdre en silence ni
     retenir l'utilisateur devant la fenêtre : on lui pose la question dans l'interface —
     une boîte de dialogue du système, avec son titre « magpie » et ses boutons OK / Cancel,
     est un corps étranger au milieu d'un écran soigné. */
  const [leaving, setLeaving] = useState(false)
  const setStepsRunning = useStore((state) => state.setStepsRunning)
  const setStepStates = useStore((state) => state.setStepStates)
  const cancelSync = useStore((state) => state.cancelSync)

  /** Coupe tout ce que la préparation a pu lancer, quelle qu'en soit l'étape. */
  const stopEverything = useCallback(async (): Promise<void> => {
    setStepsRunning(false)
    setStepStates({ sync: 'todo', thumbnails: 'todo', clips: 'todo', transcribe: 'todo', group: 'todo' })
    await Promise.allSettled([
      cancelSync(),
      magpie.stopPreload('thumbnails'),
      magpie.stopPreload('clips'),
      magpie.stopTranscription()
    ])
  }, [cancelSync, setStepStates, setStepsRunning])
  const onClose = useCallback((): void => {
    if (stepsRunning) setLeaving(true)
    else requestClose()
  }, [requestClose, stepsRunning])
  const [result, setResult] = useState<AiCollectionApplyResult | null>(null)
  const [rememberChoices, setRememberChoices] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewPosts, setPreviewPosts] = useState<Post[]>([])
  /* Ce que l'infobulle sait du point survolé. Le survol n'en donne que l'identifiant : le
     reste se cherche, et l'infobulle s'ouvre sans l'attendre. */
  const [mapDetail, setMapDetail] = useState<{ id: string; title: string; text: string } | null>(
    null
  )
  const mapHoverRef = useRef(0)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const [colourMode, setColourMode] = useState<ColourMode>('group')
  const [mapData, setMapData] = useState<OrganizerMapData | null>(null)
  const [lassoed, setLassoed] = useState<string[]>([])
  /** Les noms d'amas sur la carte. Affichés par défaut : sans eux on ne sait pas où l'on est. */
  const [showLabels, setShowLabels] = useState(true)
  /** Les contours des collections. C'est la lecture qu'on vient chercher : affichés d'emblée. */
  const [showBoundaries, setShowBoundaries] = useState(true)
  /** Les frontières déjà rangées en base, relues à l'ouverture. */
  const [savedBoundaries, setSavedBoundaries] = useState<Map<string, Vertex[][]>>(new Map())
  /** La frontière en cours de retouche, pour l'annoncer et proposer d'en sortir. */
  const [editingBoundary, setEditingBoundary] = useState<string | null>(null)
  /** Demande de régénération en attente de confirmation. */
  const [confirmRegen, setConfirmRegen] = useState(false)
  /** Mode édition des frontières. Explicite, parce qu'un geste qui déforme ne doit pas surprendre. */
  const [editMode, setEditMode] = useState(false)
  /** Le post ouvert dans le panneau latéral, à côté de la carte. */
  const [panelPostId, setPanelPostId] = useState<string | null>(null)
  const [lastApplication, setLastApplication] = useState<OrganizerApplicationSummary | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState<OrganizerUndoResult | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const previewRequestRef = useRef(0)

  useEffect(() => {
    if (!open) return
    // Rouvrir pendant une préparation doit retrouver l'écran tel qu'il était, pas le vider.
    if (useStore.getState().stepsRunning) return
    setPhase('intro')
    setPlan(null)
    setSuggestions([])
    setLastMerge(null)
    setMapData(null)
    setLassoed([])
    setPanelPostId(null)
    setError(null)
    setResult(null)
    setRememberChoices(autoOrganizeEnabled)
    setPreviewId(null)
    setPreviewPosts([])
    setPreviewLoading(false)
    setPreviewError(false)
    setUndoing(false)
    setUndone(null)
    // Un classement se regrette souvent après avoir refermé la fenêtre : la proposition
    // d'annulation doit donc être là dès l'ouverture, pas seulement juste après coup.
    void magpie.lastOrganizerApplication().then(setLastApplication).catch(() => {})
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

  useEffect(() => {
    if (!open) return
    void magpie
      .organizerBoundaries()
      .then((rows) => {
        /* Une forme illisible ne doit pas emporter l'écran : on la laisse de côté et la
           frontière se recalcule, ce qui est exactement ce qu'il faut faire d'un contour
           qu'on ne sait plus lire. */
        const parsed = new Map<string, Vertex[][]>()
        for (const row of rows) {
          try {
            const rings = JSON.parse(row.shape) as Vertex[][]
            if (Array.isArray(rings) && rings.length > 0) parsed.set(row.name, rings)
          } catch {
            console.warn('[magpie] Frontière illisible, ignorée :', row.name)
          }
        }
        setSavedBoundaries(parsed)
      })
      .catch(() => {})
  }, [open])

  /**
   * Une frontière vient d'être déformée.
   *
   * Deux effets, et le second est le vrai : la région est rangée en base — ce qui fige la
   * carte du même coup — et les posts qu'elle contient désormais rejoignent la collection.
   * Le groupe devient « épinglé » : ses posts sont désignés, plus déduits, donc une prochaine
   * analyse ne les reprendra pas. C'est ce qui fait de la frontière un classeur et non une
   * décoration.
   */
  const onBoundaryChange = useCallback(
    (group: string, rings: Vertex[][], inside: string[]): void => {
      const chosen = new Set(inside)
      setSuggestions((current) =>
        current.map((suggestion) => {
          if (suggestion.id === group) {
            return { ...suggestion, pinned: true, postIds: [...chosen] }
          }
          // Un post ne vit que dans une collection : celle qui le prend le retire aux autres.
          return { ...suggestion, postIds: suggestion.postIds.filter((id) => !chosen.has(id)) }
        })
      )
      void magpie.saveOrganizerBoundary(group, JSON.stringify(rings), inside).catch(() => {})
    },
    []
  )

  const redistributed = useMemo(
    () =>
      redistributeOrganizerRoutes(
        suggestions.map((suggestion) =>
          suggestion.pinned ? suggestion : { ...suggestion, postIds: undefined }
        ),
        plan?.routes ?? []
      ),
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
  /* Les noms suivent les renommages en cours : l'étiquette sur la carte doit dire ce que
     l'utilisateur vient de taper, pas ce que l'analyse avait proposé. */
  const groupNames = useMemo(
    () => new Map(suggestions.map((suggestion) => [suggestion.id, suggestion.name.trim()])),
    [suggestions]
  )

  if (!open) return null

  const analyse = async (): Promise<void> => {
    setPhase('loading')
    setError(null)
    try {
      const next = await magpie.proposeAiCollections()
      setPlan(next)
      setSuggestions(next.suggestions.map((suggestion) => ({ ...suggestion, included: true })))
      setLastMerge(null)
      setPreviewId(null)
      setPhase('review')
      void magpie
        .organizerMap()
        .then(setMapData)
        // La carte peut échouer sans emporter le reste : les catégories restent utilisables.
        .catch((reason: unknown) => {
          setMapData({ points: [], plan: next })
          setError(reason instanceof Error ? reason.message : String(reason))
        })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('intro')
    }
  }

  /* Une fusion se décidait sans retour possible : la catégorie source disparaissait de la
     liste et seule une nouvelle analyse la ramenait. On garde l'état d'avant pour pouvoir
     revenir en arrière — c'est un geste d'exploration, il doit se défaire. */
  const merge = (sourceId: string, targetId: string): void => {
    if (!targetId || sourceId === targetId) return
    setPreviewId(null)
    setPreviewPosts([])
    setSuggestions((current) => {
      const source = current.find((item) => item.id === sourceId)
      const target = current.find((item) => item.id === targetId)
      if (!source || !target) return current
      setLastMerge({ before: current, sourceName: source.name, targetName: target.name })
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

  /* Entourer des points crée une catégorie comme une autre : renommable, exclue d'un clic,
     fusionnable. C'est ce qui rend la fusion réversible — on redessine au lieu de défaire. */
  const createFromLasso = async (): Promise<void> => {
    if (lassoed.length === 0) return
    const chosen = new Set(lassoed)
    setSuggestions((current) => [
      {
        id: `lasso-${Date.now()}`,
        ruleKeys: [],
        name: t('organizer.lassoName', { count: chosen.size }),
        description: t('organizer.lassoDescription'),
        postIds: [...chosen],
        included: true,
        // Rattachement explicite : aucune route ne peut reprendre ces posts.
        pinned: true
      },
      // Les posts entourés quittent leur groupe d'origine : un post ne vit que dans une
      // collection à la fois, et laisser le doublon donnerait deux comptes contradictoires.
      ...current.map((suggestion) => ({
        ...suggestion,
        postIds: suggestion.postIds.filter((postId) => !chosen.has(postId))
      }))
    ])
    setLassoed([])
  }

  const undoMerge = (): void => {
    if (!lastMerge) return
    setSuggestions(lastMerge.before)
    setLastMerge(null)
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

  const undo = async (): Promise<void> => {
    setUndoing(true)
    setError(null)
    try {
      const result = await magpie.undoOrganizerApplication()
      setUndone(result)
      setLastApplication(null)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('organizer.undoError'))
    } finally {
      setUndoing(false)
    }
  }

  /** Bandeau d'annulation, proposé tant qu'un classement reste défaisable. */
  const undoPanel = (): React.JSX.Element | null => {
    if (undone) {
      return (
        <p className="organizer-undo organizer-undo--done" aria-live="polite">
          {t('organizer.undoDone', {
            removed: undone.removed,
            collections: undone.collectionsDeleted
          })}
        </p>
      )
    }
    if (!lastApplication) return null
    return (
      <div className="organizer-undo">
        <div>
          <strong>
            {t('organizer.undoLast', {
              collections: lastApplication.collections,
              posts: lastApplication.posts,
              when: formatDateTime(lastApplication.appliedAt)
            })}
          </strong>
          <span>{t('organizer.undoHint')}</span>
        </div>
        <button type="button" className="btn" disabled={undoing} onClick={() => void undo()}>
          {undoing ? t('organizer.undoing') : t('organizer.undo')}
        </button>
      </div>
    )
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
      setLastApplication(await magpie.lastOrganizerApplication().catch(() => null))
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
        {leaving ? (
          <div className="confirm" role="alertdialog" aria-modal="true">
            <div className="confirm__panel">
              <strong>{t('organizer.leaveTitle')}</strong>
              <p>{t('organizer.leaveRunning')}</p>
              <div className="confirm__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    setLeaving(false)
                    requestClose()
                  }}
                >
                  {t('organizer.leaveBackground')}
                </button>
                {/* Continuer en fond n'est pas toujours ce qu'on veut : une transcription
                    lancée par erreur occupe la machine des heures. Il faut pouvoir tout
                    couper d'un geste, pas seulement s'en aller. */}
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void stopEverything()
                    setLeaving(false)
                    requestClose()
                  }}
                >
                  {t('organizer.leaveStop')}
                </button>
                <button type="button" className="btn" onClick={() => setLeaving(false)}>
                  {t('organizer.leaveStay')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

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
              {error ? <p className="organizer-error">{error}</p> : null}
              {/* Les étapes s'enchaînent au lieu d'être cinq entrées de menu à cliquer dans
                  le bon ordre : on coche ce qu'on veut, on lance une fois. */}
              <OrganizerSteps onFinished={() => void analyse()} />
              <small>{t('organizer.costNote')}</small>
              {undoPanel()}
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
                  : organizerProgress?.stage === 'embedding'
                    ? t('organizer.embedding', {
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
              {lastMerge ? (
                <div className="organizer-undo-merge" role="status">
                  <span>
                    {t('organizer.mergedInto', {
                      source: lastMerge.sourceName,
                      target: lastMerge.targetName
                    })}
                  </span>
                  <button type="button" className="btn" onClick={undoMerge}>
                    {t('organizer.undoMerge')}
                  </button>
                </div>
              ) : null}
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
              {/* La carte est la vue par défaut : voir pourquoi l'algorithme a groupé ce
                  qu'il a groupé vaut mieux que le croire sur parole, et zéro collection
                  n'avait jamais été créée depuis la seule liste. La liste reste à un clic
                  pour renommer et cocher en série, ce qu'une carte fait mal. */}
              {/* Pas d'onglets Carte / Liste : la carte est la vue, et les catégories se
                  listent dessous pour renommer et cocher. Deux onglets pour deux moitiés du
                  même écran faisaient chercher où était passé le reste. */}

              <div className="organizer-views">
                <div className="segmented segmented--quiet">
                  {(['group', 'platform', 'kind', 'source'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={colourMode === mode ? 'is-active' : ''}
                      onClick={() => setColourMode(mode)}
                    >
                      {t(
                        `organizer.colour${mode[0].toUpperCase()}${mode.slice(1)}` as Parameters<
                          typeof t
                        >[0]
                      )}
                    </button>
                  ))}
                </div>
                {/* Les noms d'amas couvrent la toile qu'ils désignent : pouvoir les éteindre
                    rend la carte lisible en tant qu'image, sans perdre le repérage. */}
                <button
                  type="button"
                  className={`segmented__toggle${showLabels ? ' is-active' : ''}`}
                  aria-pressed={showLabels}
                  onClick={() => setShowLabels((current) => !current)}
                >
                  {t(showLabels ? 'organizer.labelsHide' : 'organizer.labelsShow')}
                </button>
                <button
                  type="button"
                  className={`segmented__toggle${editMode ? ' is-active' : ''}`}
                  aria-pressed={editMode}
                  disabled={!showBoundaries}
                  onClick={() =>
                    setEditMode((current) => {
                      /* Éditer suppose de voir ce qu'on édite : allumer le mode allume les
                         frontières, et les masquer le coupe. */
                      if (!current) setShowBoundaries(true)
                      return !current
                    })
                  }
                >
                  {t(editMode ? 'organizer.edgeEditDone' : 'organizer.edgeEdit')}
                </button>
                <button
                  type="button"
                  className={`segmented__toggle${showBoundaries ? ' is-active' : ''}`}
                  aria-pressed={showBoundaries}
                  onClick={() =>
                    setShowBoundaries((current) => {
                      /* Afficher les frontières éteint les noms d'amas : ils désignent le
                         regroupement, pas la collection, et se superposaient aux contours
                         sans rien ajouter. Le bouton des noms reste là pour les rappeler —
                         ils reviennent alors posés dans leur région et à sa couleur. */
                      if (!current) setShowLabels(false)
                      else setEditMode(false)
                      return !current
                    })
                  }
                >
                  {t(showBoundaries ? 'organizer.edgesHide' : 'organizer.edgesShow')}
                </button>
              </div>

              {mapData ? (
                  <>
                    <div className="organizer-stage">
                    <OrganizerMap
                      data={mapData}
                      colourMode={colourMode}
                      groupNames={groupNames}
                      showLabels={showLabels}
                      showBoundaries={showBoundaries}
                      editMode={editMode}
                      savedBoundaries={savedBoundaries}
                      onBoundaryChange={onBoundaryChange}
                      onEditingChange={setEditingBoundary}
                  includedGroups={
                        new Set(suggestions.filter((s) => s.included).map((s) => s.id))
                      }
                      onLasso={setLassoed}
                      detail={mapDetail}
                      onHover={(point) => {
                        /* Une requête par point survolé serait une requête par pixel parcouru :
                           on ne cherche que ce qui est encore survolé au bout du délai, et une
                           réponse en retard est jetée. */
                        const request = ++mapHoverRef.current
                        if (!point) {
                          setMapDetail(null)
                          return
                        }
                        if (mapDetail?.id !== point.id) setMapDetail(null)
                        window.setTimeout(() => {
                          if (mapHoverRef.current !== request) return
                          void magpie.getPostsByIds([point.id]).then((posts) => {
                            const post = posts[0]
                            if (!post || mapHoverRef.current !== request) return
                            setMapDetail({
                              id: point.id,
                              title: displayName(post),
                              text: post.text?.slice(0, 220) ?? ''
                            })
                          })
                        }, 90)
                      }}
                      onOpen={(point) => setPanelPostId(point.id)}
                    />
                    <MapPostPanel postId={panelPostId} onClose={() => setPanelPostId(null)} />
                    </div>
                    {editingBoundary ? (
                      <div className="organizer-lasso" role="status">
                        <span>
                          {t('organizer.edgeEditing', {
                            name: groupNames.get(editingBoundary) ?? ''
                          })}
                        </span>
                      </div>
                    ) : null}
                    {savedBoundaries.size > 0 ? (
                      <div className="organizer-lasso" role="status">
                        <span>{t('organizer.edgeKept', { count: savedBoundaries.size })}</span>
                        {confirmRegen ? (
                          <>
                            <span className="organizer-warn">{t('organizer.edgeWarn')}</span>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setConfirmRegen(false)}
                            >
                              {t('organizer.cancel')}
                            </button>
                            <button
                              type="button"
                              className="btn btn--danger"
                              onClick={() => {
                                void magpie.clearOrganizerBoundaries().then(() => {
                                  setSavedBoundaries(new Map())
                                  setConfirmRegen(false)
                                  void analyse()
                                })
                              }}
                            >
                              {t('organizer.edgeRegenerate')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setConfirmRegen(true)}
                          >
                            {t('organizer.edgeRegenerate')}
                          </button>
                        )}
                      </div>
                    ) : null}
                    {lassoed.length > 0 ? (
                      <div className="organizer-lasso" role="status">
                        <span>{t('organizer.mapSelected', { count: lassoed.length })}</span>
                        <button type="button" className="btn" onClick={() => setLassoed([])}>
                          {t('organizer.mapClear')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => void createFromLasso()}
                        >
                          {t('organizer.mapCreate')}
                        </button>
                      </div>
                    ) : null}
                  </>
              ) : (
                <div className="organizer-loading">
                  <div className="organizer-spinner" />
                  <p>{t('organizer.projecting')}</p>
                </div>
              )}

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
              {/* Renommer une catégorie du nom d'une collection existante y verse son
                  contenu. C'est voulu, mais ça se faisait sans le dire. */}
              {result && result.joinedExisting.length > 0 ? (
                <p className="organizer-joined">
                  {t('organizer.joinedExisting', { names: result.joinedExisting.join(', ') })}
                </p>
              ) : null}
              {rememberChoices ? <p>{t('organizer.rememberDone')}</p> : null}
              {error ? <p className="organizer-error">{error}</p> : null}
              {undoPanel()}
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
