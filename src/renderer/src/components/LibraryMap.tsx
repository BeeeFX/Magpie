import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CollectionMembership,
  OrganizerMap as OrganizerMapData,
  OrganizerProgress
} from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import type { Vertex } from '../map-boundaries'
import { displayName } from '../format'
import { useStore, useT } from '../store'
import { IconClose } from './Icons'
import { swatchOf } from '../collection-colours'
import { CollectionsRail } from './CollectionsRail'
import { MapPerf } from './MapPerf'
import { OrganizerMap, type ColourMode } from './OrganizerMap'
import { MapPostPanel } from './MapPostPanel'

/**
 * La carte sémantique, à l'écran principal.
 *
 * Troisième façon de regarder sa bibliothèque, après la mosaïque et les cartes : les posts
 * placés par ressemblance plutôt que par date. Ce que les deux autres ne montrent pas, c'est
 * *ce qui va avec quoi* — et c'est souvent la question qu'on se pose devant neuf mille posts.
 *
 * Elle suit les filtres courants. Collection choisie, recherche, favoris : la carte montre
 * exactement ce que la grille montrerait. La projection, elle, reste calculée sur la
 * bibliothèque entière — les points gardés ne bougent donc pas quand on filtre, ils
 * disparaissent seulement. C'est voulu : un point qui se déplacerait selon le filtre ne
 * voudrait plus rien dire.
 *
 * Et elle a un état vide qui explique quoi faire. Personne n'attend une heure d'analyse avant
 * d'avoir vu à quoi sert l'application : sans les vecteurs, ce mode ne peut rien afficher, et
 * un canevas noir sans explication passerait pour une panne.
 */

/**
 * Ce que cet écran ne fait pas, hissé hors du composant.
 *
 * La carte d'accueil ne trace pas de frontières et ne se modifie pas : les trois rappels et la
 * table de contours qu'elle passe quand même sont donc constants. Les écrire à l'appel les
 * recréait à chaque rendu, et `OrganizerMap` en fait des dépendances — dont celle qui
 * reconstruit le pavage entier, Voronoï compris. Il se refaisait à chaque vignette arrivée, sur
 * le thread du rendu, pour un maillage que cet écran ne dessine même pas.
 */
const NO_BOUNDARIES: Map<string, Vertex[][]> = new Map()
const IGNORE = (): void => {}

/** Les étapes que l'analyse annonce, dans l'ordre où elle les traverse. */
const STAGE_LABEL = {
  preparing: 'organizer.preparing',
  visuals: 'organizer.visualProgress',
  embedding: 'organizer.embedding',
  grouping: 'organizer.grouping',
  projecting: 'organizer.projecting'
} as const

export function LibraryMap(): React.JSX.Element {
  const t = useT()
  const query = useStore((state) => state.query)
  const setOrganizerOpen = useStore((state) => state.setOrganizerOpen)
  const organizeMode = useStore((state) => state.organizeMode)
  const [data, setData] = useState<OrganizerMapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [panelPostId, setPanelPostId] = useState<string | null>(null)
  const [ownLabels, setOwnLabels] = useState<{ id: string; text: string; anchors: string[] }[]>([])
  /** Étiquette en cours de saisie : ses ancres sont déjà choisies, il manque le mot. */
  const [naming, setNaming] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')
  /** Reposer le même écran ne change aucun état : il faut un compteur pour redemander. */
  const [attempt, setAttempt] = useState(0)
  /**
   * Quels noms la carte affiche.
   *
   * Trois familles qui disaient trois choses et qu'un seul bouton commandait — ou plutôt, dont
   * la troisième n'avait aucun bouton. Les amas sortent de l'analyse, les collections de ce que
   * l'utilisateur a écrit, les étiquettes de ce qu'il a nommé lui-même.
   */
  const [titles, setTitles] = useState({ groups: true, collections: true, own: true })
  /** Les collections, pour teinter les points et poser leurs noms. */
  const [rooms, setRooms] = useState<CollectionMembership[]>([])
  /**
   * Ce que la couleur raconte.
   *
   * La carte n'en disait qu'une chose — la collection — alors que les mêmes points ont plusieurs
   * lectures : d'où ils viennent, ce qu'ils sont, comment ils sont arrivés. C'est le même nuage
   * relu quatre fois, et c'est là que la carte devient un instrument plutôt qu'une image. La
   * chaleur d'une collection, elle, passe devant dès qu'on en choisit une : on l'a demandée.
   */
  const [colourMode, setColourMode] = useState<ColourMode>('group')
  /**
   * La largeur du panneau, gardée ici pour survivre à sa fermeture.
   *
   * La moitié de l'écran par défaut : c'est la taille à laquelle on voit ce qu'un post est, et
   * c'était le reproche fait aux trois cents pixels de l'organisateur — un aperçu trop petit
   * pour reconnaître ce qu'on vient de cliquer ne sert à rien.
   */
  const [panelWidth, setPanelWidth] = useState(() => Math.round(window.innerWidth / 2))
  /* L'infobulle du survol. Elle existait dans l'organisateur et pas ici — un point survolé ne
     disait rien de ce qu'il était, ce qui est pourtant la première question qu'on se pose devant
     neuf mille points. Une requête par point survolé serait une requête par pixel parcouru : on
     ne cherche que ce qui est encore sous le curseur au bout du délai, et une réponse en retard
     est jetée. */
  const [detail, setDetail] = useState<{ id: string; title: string; text: string } | null>(null)
  const hoverRef = useRef(0)
  /** La collection regardée, peinte en chaleur sur la carte. */
  const [heat, setHeat] = useState<{
    token: string
    degrees: Map<string, number>
    reach: number
    only: boolean
  } | null>(null)


  /* L'analyse dit déjà où elle en est — c'est le même flux que l'organisateur écoute. Le
     brancher ici coûte trois lignes et change tout : à froid, ouvrir cet onglet relance le
     regroupement puis les vingt-six secondes de projection, et un rond qui tourne sans rien
     annoncer pendant une demi-minute se lit comme un blocage. */
  const [progress, setProgress] = useState<OrganizerProgress | null>(null)
  useEffect(() => magpieEvents.onOrganizerProgress(setProgress), [])

  /* Échap sort de la saisie et du mode, d'où que vienne le focus. Il n'était écouté que par le
     champ lui-même : un clic ailleurs et la boîte ne se fermait plus par aucun moyen. */
  useEffect(() => {
    if (!naming) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setNaming(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [naming])

  /* Rechargées quand la chaleur change : c'est le signe qu'une collection vient d'être créée,
     redéfinie ou recolorée, donc que les teintes et les noms ont bougé. */
  useEffect(() => {
    void magpie
      .collectionMembership()
      .then(setRooms)
      .catch((error) => console.warn('[magpie] Collections illisibles', error))
  }, [heat?.token])

  useEffect(() => {
    void magpie
      .mapLabels()
      .then(setOwnLabels)
      // Une table absente ou illisible ne doit pas emporter l'écran, mais l'avaler en silence
      // faisait d'une fonction morte une fonction qu'on croyait vivante.
      .catch((error) => console.warn('[magpie] Étiquettes de carte illisibles', error))
  }, [])

  /**
   * Tout ce que le filtre retient, et non la page que la grille a chargée.
   *
   * C'était le défaut de cet écran. Il filtrait la projection sur `state.posts`, qui est la
   * tranche paginée de la mosaïque — trois cents posts. Or la grille n'est pas montée dans ce
   * mode : rien n'appelait jamais la tranche suivante. La carte restait donc à trois cents
   * points sur neuf mille, silencieusement, en donnant tous les signes d'être complète.
   */
  const [visibleIds, setVisibleIds] = useState<Set<string> | null>(null)
  useEffect(() => {
    let cancelled = false
    void magpie
      .listPostIds(query)
      .then((ids) => {
        if (!cancelled) setVisibleIds(new Set(ids))
      })
      .catch((error) => {
        console.warn('[magpie] Filtre de carte indisponible', error)
        if (!cancelled) setVisibleIds(null)
      })
    return () => {
      cancelled = true
    }
  }, [query])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailure(null)
    void magpie
      .organizerMap('equilibre')
      .then((next) => {
        if (!cancelled) setData(next)
      })
      .catch((error: unknown) => {
        /* Une analyse qui échoue n'est pas une bibliothèque sans vecteurs. Les confondre
           renvoyait vers « lancer l'analyse » un écran qui venait précisément de la voir
           échouer, et l'utilisateur relançait la même panne. */
        console.error('[magpie] Carte indisponible', error)
        if (cancelled) return
        setData(null)
        setFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  /* Les points que les filtres ont laissés. Le placement vient de la projection complète : on
     retire des points, on ne les redispose pas. */
  const shown = useMemo(() => {
    if (!data) return null
    if (!visibleIds) return data
    return { ...data, points: data.points.filter((point) => visibleIds.has(point.id)) }
  }, [data, visibleIds])

  const groupNames = useMemo(
    () => new Map((data?.plan.suggestions ?? []).map((s) => [s.id, s.name.trim()])),
    [data]
  )
  const includedGroups = useMemo(
    () => new Set((data?.plan.suggestions ?? []).map((s) => s.id)),
    [data]
  )

  /* Prévenir, jamais refuser. Une grande bibliothèque coûte du temps de projection, mais lui
     interdire la carte serait pire : on annonce la durée et on laisse décider. Repère mesuré —
     26 s pour 9 740 posts, et le coût monte en n·log n, ce qui donne l'ordre de grandeur sans
     prétendre à la seconde près. */
  /** Les collections telles que la carte les lit : une teinte, un nom, ses membres. */
  const mapRooms = useMemo(
    () =>
      rooms
        .filter((room) => room.postIds.length > 0)
        .map((room) => ({
          id: room.id,
          name: room.name,
          tone: swatchOf(room.color),
          members: new Set(room.postIds)
        })),
    [rooms]
  )

  const count = shown?.points.length ?? 0
  const heavy = count > 15_000
  const estimate = Math.max(
    1,
    Math.round((26 * (count / 9740) * Math.log2(Math.max(2, count))) / Math.log2(9740) / 60)
  )

  /**
   * La carte demande l'analyse approfondie, et le dit avant de charger quoi que ce soit.
   *
   * Le rangement rapide ne lit ni les images ni le son : il ne produit pas la matière dont la
   * projection a besoin. Ouvrir cet onglet aurait donc lancé une analyse complète à l'insu de
   * la personne — une heure de calcul pour avoir cliqué sur un onglet. Un verrou qui explique et
   * qui propose vaut mieux qu'une attente qu'on n'a pas demandée.
   *
   * Le fond est un décor, pas des données : un semis de points qui suggère ce qui viendra, sans
   * prétendre montrer une carte qui n'existe pas encore.
   */
  if (organizeMode !== 'deep') {
    return (
      <div className="library-map__empty library-map__locked">
        <h2>{t('map.lockedTitle')}</h2>
        <p>{t('map.lockedText')}</p>
        <button type="button" className="btn btn--primary" onClick={() => setOrganizerOpen(true)}>
          {t('map.lockedAction')}
        </button>
      </div>
    )
  }

  if (loading) {
    const label = progress?.running ? STAGE_LABEL[progress.stage as keyof typeof STAGE_LABEL] : null
    return (
      <div className="library-map__empty">
        <div className="organizer-spinner" />
        <p>
          {label
            ? t(label, { done: progress?.done ?? 0, total: progress?.total ?? 0 })
            : t('map.loading')}
        </p>
        {progress?.running && progress.total > 0 ? (
          <div
            className="organizer-progress"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
          >
            <span style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }} />
          </div>
        ) : null}
      </div>
    )
  }

  /* Une analyse qui a échoué le dit, et propose de recommencer. Elle ne se déguise pas en
     bibliothèque à analyser. */
  if (failure) {
    return (
      <div className="library-map__empty">
        <h2>{t('map.errorTitle')}</h2>
        <p>{failure}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setAttempt((current) => current + 1)}
        >
          {t('map.errorRetry')}
        </button>
      </div>
    )
  }

  /* Pas de vecteurs, pas de carte. On le dit, et on donne le bouton qui les fabrique — plutôt
     qu'un cadre noir qui ressemble à une panne. */
  if (!shown || shown.points.length === 0) {
    return (
      <div className="library-map__empty">
        <h2>{t('map.emptyTitle')}</h2>
        <p>{t('map.emptyText')}</p>
        <button type="button" className="btn btn--primary" onClick={() => setOrganizerOpen(true)}>
          {t('map.emptyAction')}
        </button>
      </div>
    )
  }

  return (
    <div className="library-map">
      {/* Un seul regard, et un bouton.
          Les quatre mélanges — équilibré, sujet, style, texte — sont partis. Trois d'entre eux
          rapprochaient sur un signal isolé, ce qui donne trois cartes moins bonnes que celle que
          la mesure retient, et quatre onglets à essayer pour revenir au premier. Une carte qui a
          quatre versions n'est plus un endroit : on ne peut pas s'y souvenir d'où était quelque
          chose. Le mélange équilibré reste, seul.
          À la place, ce qui manquait vraiment : de quoi nommer un endroit. Le geste existait
          — double-clic — et rien ne l'annonçait. */}
      <div className="library-map__tools">
        {/* Cinq lectures du même nuage. Le groupe d'abord : c'est celle qu'on vient voir. */}
        <div className="segmented segmented--quiet library-map__colours">
          {(['group', 'collection', 'platform', 'kind', 'source'] as const).map((mode) => (
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
        {/* Les trois familles de noms. Poser une étiquette se fait au clic droit sur la carte :
            le bouton qui armait un mode a disparu avec le mode. */}
        <div className="library-map__titles" role="group" aria-label={t('map.titles')}>
          {(['groups', 'collections', 'own'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`btn library-map__label${titles[kind] ? ' is-active' : ''}`}
              aria-pressed={titles[kind]}
              onClick={() => setTitles((current) => ({ ...current, [kind]: !current[kind] }))}
            >
              {t(`map.titles${kind[0].toUpperCase()}${kind.slice(1)}` as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>
      </div>
      {heavy ? (
        <p className="library-map__notice" role="status">
          {t('map.heavy', { count, minutes: estimate })}
        </p>
      ) : null}
      <CollectionsRail onHeat={setHeat} />
      <OrganizerMap
        data={shown}
        colourMode={colourMode}
        includedGroups={includedGroups}
        groupNames={groupNames}
        showLabels={titles.groups}
        showBoundaries={false}
        editMode={false}
        savedBoundaries={NO_BOUNDARIES}
        onBoundaryChange={IGNORE}
        onLasso={IGNORE}
        onHover={(point) => {
          const request = ++hoverRef.current
          if (!point) {
            setDetail(null)
            return
          }
          if (detail?.id !== point.id) setDetail(null)
          window.setTimeout(() => {
            if (hoverRef.current !== request) return
            void magpie.getPostsByIds([point.id]).then((posts) => {
              const post = posts[0]
              if (!post || hoverRef.current !== request) return
              setDetail({
                id: point.id,
                title: displayName(post),
                text: post.text?.slice(0, 220) ?? ''
              })
            })
          }, 90)
        }}
        /* Un clic ouvre le post dans le panneau, comme dans l'organisateur. Le détail complet
           reste accessible depuis la grille : ici on veut regarder sans quitter la carte. */
        onOpen={(point) => setPanelPostId(point.id)}
        ownLabels={ownLabels}
        onRemoveLabel={(id) => {
          setOwnLabels((current) => current.filter((label) => label.id !== id))
          void magpie
            .deleteMapLabel(id)
            .catch((error) => console.warn('[magpie] Étiquette non retirée', error))
        }}
        heat={heat}
        collections={mapRooms}
        showCollectionNames={titles.collections}
        showOwnLabels={titles.own}
        menuOnRightClick
        onPlaceLabel={(anchors) => {
          setNaming(anchors)
          setDraft('')
        }}
        detail={detail}
      />
      {/* Nommer un endroit. Un champ posé sur la carte plutôt qu'une boîte du système : on
          reste devant ce qu'on nomme, et l'application garde son écran. */}
      {naming ? (
        <form
          className="library-map__naming"
          onSubmit={(event) => {
            event.preventDefault()
            const text = draft.trim()
            if (!text) {
              setNaming(null)
              return
            }
            const id = `label-${Date.now()}`
            setOwnLabels((current) => [...current, { id, text, anchors: naming }])
            void magpie
              .saveMapLabel(id, text, naming)
              .catch((error) => console.warn('[magpie] Étiquette non enregistrée', error))
            setNaming(null)
          }}
        >
          <input
            autoFocus
            value={draft}
            placeholder={t('map.namePlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setNaming(null)
            }}
          />
          <button type="submit" className="btn btn--primary">
            {t('map.nameSave')}
          </button>
          {/* Renoncer. Une boîte de saisie sans sortie visible est une impasse : Échap ne se
              devine pas, et rien d'autre ne la fermait. */}
          <button
            type="button"
            className="icon-btn"
            onClick={() => setNaming(null)}
            aria-label={t('organizer.cancel')}
          >
            <IconClose />
          </button>
        </form>
      ) : null}
      <MapPerf />
      <MapPostPanel
        postId={panelPostId}
        onClose={() => setPanelPostId(null)}
        /* Par-dessus, et non à côté : la carte garde sa taille, donc elle ne se recale pas à
           l'ouverture — et le panneau peut glisser sans entraîner neuf mille points. */
        variant="floating"
        width={panelWidth}
        onResize={setPanelWidth}
      />
    </div>
  )
}
