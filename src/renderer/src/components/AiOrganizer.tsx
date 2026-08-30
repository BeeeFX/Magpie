import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CollectionInfo,
  AiCollectionApplyResult,
  OrganizerApplicationSummary,
  OrganizerProgress,
  OrganizerUndoResult
} from '@shared/types'
import { AFTER_SYNC_STEPS } from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { useClosing } from '../useClosing'
import { formatDateTime } from '../format'
import { notifyError, reportFailure } from '../notices'
import { useStore, useT } from '../store'
import { IconClock, IconClose, IconMap } from './Icons'
import { OrganizerSteps } from './OrganizerSteps'

interface Props {
  open: boolean
  onClose(): void
}



export function AiOrganizer({ open, onClose: requestClose }: Props): React.JSX.Element | null {
  const t = useT()
  const refresh = useStore((state) => state.refresh)
  const loadSettings = useStore((state) => state.loadSettings)
  const autoOrganizeEnabled = useStore((state) => state.autoOrganizeEnabled)
  const stepsRunning = useStore((state) => state.stepsRunning)
  const [organizerProgress, setOrganizerProgress] = useState<OrganizerProgress | null>(null)
  const [phase, setPhase] = useState<
    'choose' | 'keep' | 'intro' | 'loading' | 'review' | 'applying' | 'done'
  >('choose')
  /**
   * Les collections déjà là, quand une analyse approfondie succède à un rangement rapide.
   *
   * Les deux produisent chacun un jeu couvrant la bibliothèque : les laisser cohabiter donnerait
   * deux fois les mêmes thèmes sous deux noms, et rien ne dirait lequel fait foi. On demande donc
   * lesquelles garder, plutôt que de choisir à la place de quelqu'un — et ce qu'il garde devient
   * une liste que plus aucun recalcul ne touche.
   */
  const [existing, setExisting] = useState<CollectionInfo[]>([])
  const [keeping, setKeeping] = useState<number[]>([])
  /**
   * Rapide ou approfondi. Choisi à l'ouverture, retenu jusqu'à la fin.
   *
   * Ce n'est pas un réglage de plus : c'est la question qui commande tout le reste. Le rangement
   * rapide ne lit ni les images ni le son — il va vite et se trompe davantage, et il s'arrête à
   * une liste. L'approfondi lit tout, sur la machine, et c'est le seul qui produise de quoi
   * dessiner la carte sémantique : d'où le bouton qui y mène quand il a fini.
   */
  const [depth, setDepth] = useState<'quick' | 'deep'>('deep')
  const [error, setError] = useState<string | null>(null)

  /* Une préparation peut durer des heures. La fermer ne doit ni tout perdre en silence ni
     retenir l'utilisateur devant la fenêtre : on lui pose la question dans l'interface —
     une boîte de dialogue du système, avec son titre « magpie » et ses boutons OK / Cancel,
     est un corps étranger au milieu d'un écran soigné. */
  const [leaving, setLeaving] = useState(false)
  const setStepChoices = useStore((state) => state.setStepChoices)
  const setAfterSync = useStore((state) => state.setAfterSync)
  const setOrganizeMode = useStore((state) => state.setOrganizeMode)
  const setGridMode = useStore((state) => state.setGridMode)
  const setStepsRunning = useStore((state) => state.setStepsRunning)
  const setStepStates = useStore((state) => state.setStepStates)
  const cancelSync = useStore((state) => state.cancelSync)

  /** Coupe tout ce que la préparation a pu lancer, quelle qu'en soit l'étape. */
  const stopEverything = useCallback(async (): Promise<void> => {
    setStepsRunning(false)
    setStepStates({ sync: 'todo', thumbnails: 'todo', clips: 'todo', transcribe: 'todo', group: 'todo' })
    /* `allSettled` ne rejette jamais : chaque arrêt qui échoue est simplement noté, et les
       autres continuent. Couper une préparation ne doit pas dépendre du succès des quatre. */
    const stops = await Promise.allSettled([
      cancelSync(),
      magpie.stopPreload('thumbnails'),
      magpie.stopPreload('clips'),
      magpie.stopTranscription()
    ])
    for (const stop of stops) {
      if (stop.status === 'rejected') notifyError('notice.unexpected', stop.reason)
    }
  }, [cancelSync, setStepStates, setStepsRunning])
  const onClose = useCallback((): void => {
    if (stepsRunning) setLeaving(true)
    else requestClose()
  }, [requestClose, stepsRunning])
  const [result, setResult] = useState<AiCollectionApplyResult | null>(null)
  const [rememberChoices, setRememberChoices] = useState(false)
  const [lastApplication, setLastApplication] = useState<OrganizerApplicationSummary | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState<OrganizerUndoResult | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const { mounted, closing } = useClosing(open, 230)

  useEffect(() => {
    if (!open) return
    // Rouvrir pendant une préparation doit retrouver l'écran tel qu'il était, pas le vider.
    if (useStore.getState().stepsRunning) return
    setPhase('choose')
    setError(null)
    setResult(null)
    setRememberChoices(autoOrganizeEnabled)
    setUndoing(false)
    setUndone(null)
    // Un classement se regrette souvent après avoir refermé la fenêtre : la proposition
    // d'annulation doit donc être là dès l'ouverture, pas seulement juste après coup.
    void magpie.lastOrganizerApplication().then(setLastApplication).catch(() => {})
    requestAnimationFrame(() => panelRef.current?.focus())
  }, [open])

  /**
   * Échappée : à part, et surtout pas dans l'effet qui remet l'écran à zéro.
   *
   * Les deux vivaient ensemble, avec `onClose` en dépendance. Or `onClose` change d'identité
   * dès que `stepsRunning` bascule — c'est-à-dire juste avant que l'analyse ne démarre. La
   * préparation à peine finie, l'écran revenait au choix rapide/approfondi pendant quelques
   * secondes, puis sautait au résultat : le travail semblait perdu, puis revenait tout seul.
   */
  useEffect(() => {
    if (!open) return
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



  /* Les noms suivent les renommages en cours : l'étiquette sur la carte doit dire ce que
     l'utilisateur vient de taper, pas ce que l'analyse avait proposé. */

  if (!mounted) return null

  /**
   * L'analyse finie, on constate. On ne relit plus un plan.
   *
   * Cette fenêtre montrait sa propre carte, sa propre liste de catégories, ses frontières à
   * retoucher et un bouton pour créer les collections — tout ce que la fenêtre principale fait
   * désormais mieux, avec de la place et sans modale. Elle demandait aussi d'approuver un plan
   * juste après une analyse qui a pu durer deux heures : personne n'est devant l'écran à ce
   * moment-là, et une question posée à un absent bloque le résultat au lieu de le livrer.
   *
   * L'analyse produit donc ce qu'il faut — les vecteurs, la projection, les thèmes — et s'arrête
   * là. Les collections se décrivent, se règlent et se corrigent dans le rail de la carte.
   */
  const analyse = async (): Promise<void> => {
    setPhase('loading')
    setError(null)
    try {
      const proposed = await magpie.proposeAiCollections()
      if (depth === 'quick') {
        /**
         * Le rapide crée ses collections sans rien demander.
         *
         * C'est ce qui le rend rapide au sens qui compte : on lance et on revient à une
         * bibliothèque rangée. La liste se corrige ensuite là où vivent les collections —
         * renommer, fusionner, supprimer — et non dans une fenêtre modale qui exigeait
         * d'approuver un plan avant d'avoir rien vu.
         */
        const applied = await magpie.applyAiCollections(
          proposed.suggestions.map((suggestion) => ({
            name: suggestion.name.trim(),
            postIds: suggestion.postIds,
            ruleKeys: suggestion.ruleKeys
          })),
          { remember: rememberChoices, ignoredRuleKeys: [] }
        )
        setResult(applied)
        setLastApplication(await magpie.lastOrganizerApplication().catch(() => null))
      } else {
        /* Une carte sans collection n'a rien à colorer : on pose les brouillons de thèmes, à
           élaguer et à renommer. Sans effet si des collections définies existent déjà — celles
           qu'on vient de garder, elles, sont des listes et ne comptent pas comme telles. */
        await magpie.seedCollectionsFromTopics()
      }
      /* Ce qu'on vient de préparer devient ce qui se refera tout seul.
         Sans ce report, une préparation approfondie ne tenait qu'une fois : les posts
         rapportés à la synchronisation suivante étaient rangés sur leur texte seul, sans que
         rien ne le dise, et la méthode se dégradait en silence. La question a déjà été posée
         sur l'écran d'à côté — la reposer dans un menu serait la poser deux fois. */
      await setAfterSync(
        AFTER_SYNC_STEPS.filter((step) => useStore.getState().stepChoices.includes(step))
      )
      await loadSettings()
      await setOrganizeMode(depth)
      await refresh(false, true)
      setPhase('done')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('intro')
    }
  }

  /* Une fusion se décidait sans retour possible : la catégorie source disparaissait de la
     liste et seule une nouvelle analyse la ramenait. On garde l'état d'avant pour pouvoir
     revenir en arrière — c'est un geste d'exploration, il doit se défaire. */

  /* Entourer des points crée une catégorie comme une autre : renommable, exclue d'un clic,
     fusionnable. C'est ce qui rend la fusion réversible — on redessine au lieu de défaire. */




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


  return (
    <div className={`modal ai-organizer ${closing ? 'is-closing' : ''}`} onMouseDown={onClose}>
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

        <div
          className={`modal__body ai-organizer__body${phase === 'keep' ? ' ai-organizer__body--keep' : ''}`}
        >
          {phase === 'choose' ? (
            <div className="organizer-choose">
              <h3>{t('organizer.chooseTitle')}</h3>
              <p>{t('organizer.chooseText')}</p>
              <div className="organizer-choose__cards">
                {/* Deux cartes, pas une liste d'options : le choix est franc, et chacune dit ce
                    qu'elle coûte *et* ce qu'elle vaut. Annoncer la vitesse sans annoncer la
                    perte serait un mensonge par omission. */}
                <button
                  type="button"
                  className="organizer-card"
                  onClick={() => {
                    /* Ni images ni transcription : c'est exactement ce qui fait la différence
                       de durée, et de justesse. */
                    setDepth('quick')
                    setStepChoices(['sync', 'thumbnails'])
                    setPhase('intro')
                  }}
                >
                  <span className="organizer-card__icon" aria-hidden="true">
                    <IconClock size={22} />
                  </span>
                  <strong>{t('organizer.quickTitle')}</strong>
                  <em>{t('organizer.quickTime')}</em>
                  <span className="organizer-card__text">{t('organizer.quickText')}</span>
                  <span className="organizer-card__warn">{t('organizer.quickLoss')}</span>
                </button>
                <button
                  type="button"
                  className="organizer-card organizer-card--deep"
                  onClick={() => {
                    setDepth('deep')
                    setStepChoices(['sync', 'thumbnails', 'clips', 'images', 'transcribe'])
                    /* Des collections existent déjà : on demande avant de proposer un jeu neuf
                       par-dessus. Sur une bibliothèque vierge, la question n'a pas lieu d'être. */
                    void magpie.listCollections().then((rows) => {
                      setExisting(rows)
                      setKeeping([])
                      setPhase(rows.length > 0 ? 'keep' : 'intro')
                    })
                  }}
                >
                  {/* Ce que l'approfondi apporte et que le rapide n'a pas, c'est la carte :
                      son icône doit donc être celle de la carte, pas un dossier. */}
                  <span className="organizer-card__icon" aria-hidden="true">
                    <IconMap size={22} />
                  </span>
                  <strong>{t('organizer.deepTitle')}</strong>
                  <em>{t('organizer.deepTime')}</em>
                  <span className="organizer-card__text">{t('organizer.deepText')}</span>
                  <span className="organizer-card__good">{t('organizer.deepGain')}</span>
                </button>
              </div>
              <small>{t('organizer.costNote')}</small>
              {undoPanel()}
            </div>
          ) : null}

          {phase === 'keep' ? (
            <div className="organizer-keep">
              <h3>{t('organizer.keepTitle')}</h3>
              <p>{t('organizer.keepText', { count: existing.length })}</p>
              <ul className="organizer-keep__list">
                {existing.map((room) => {
                  const on = keeping.includes(room.id)
                  return (
                    <li key={room.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            setKeeping((current) =>
                              on ? current.filter((id) => id !== room.id) : [...current, room.id]
                            )
                          }
                        />
                        <span className="organizer-keep__name">{room.name}</span>
                        <span className="organizer-keep__count">{room.count}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
              <p className="organizer-keep__note">{t('organizer.keepNote')}</p>
              <div className="organizer-keep__foot">
                <button type="button" className="btn" onClick={() => setPhase('choose')}>
                  {t('organizer.cancel')}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    void magpie
                      .keepOnlyCollections(keeping)
                      .then(() => {
                        void refresh(false, true)
                        setPhase('intro')
                      })
                      .catch(reportFailure('notice.collectionFailed'))
                  }}
                >
                  {t(
                    keeping.length === 0
                      ? 'organizer.keepNone'
                      : keeping.length === 1
                        ? 'organizer.keepOne'
                        : 'organizer.keepMany',
                    { count: keeping.length }
                  )}
                </button>
              </div>
            </div>
          ) : null}

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

          {phase === 'done' ? (
            <div className="organizer-done">
              <div className="organizer-done__check">✓</div>
              <h3>{t(depth === 'deep' ? 'organizer.readyTitle' : 'organizer.doneTitle')}</h3>
              <p>{t(depth === 'deep' ? 'organizer.readyText' : 'organizer.quickDoneText')}</p>
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
              {/* La récompense du chemin long. La carte n'existe que parce que l'analyse
                  approfondie a eu lieu : c'est le moment de la montrer, et le seul endroit où
                  l'on sait qu'elle vient d'être méritée. */}
              {depth === 'deep' ? (
                <button
                  type="button"
                  className="btn btn--primary organizer-done__map"
                  onClick={() => {
                    setGridMode('map')
                    onClose()
                  }}
                >
                  {t('organizer.openMap')}
                </button>
              ) : null}
              <button
                type="button"
                className={depth === 'deep' ? 'btn' : 'btn btn--primary'}
                onClick={onClose}
              >
                {t('organizer.close')}
              </button>
            </div>
          ) : null}
        </div>

      </div>
    </div>
  )
}
