import { useEffect, useMemo, useState } from 'react'
import type { OrganizerMap as OrganizerMapData } from '@shared/types'
import { magpie } from '../bridge'
import { useStore, useT } from '../store'
import { OrganizerMap } from './OrganizerMap'
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
export function LibraryMap(): React.JSX.Element {
  const t = useT()
  const posts = useStore((state) => state.posts)
  const setOrganizerOpen = useStore((state) => state.setOrganizerOpen)
  const [data, setData] = useState<OrganizerMapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [panelPostId, setPanelPostId] = useState<string | null>(null)
  const [ownLabels, setOwnLabels] = useState<{ id: string; text: string; anchors: string[] }[]>([])
  /** Étiquette en cours de saisie : ses ancres sont déjà choisies, il manque le mot. */
  const [naming, setNaming] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void magpie.mapLabels().then(setOwnLabels).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void magpie
      .organizerMap()
      .then((next) => {
        if (!cancelled) setData(next)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /* Les points que les filtres ont laissés. Le placement vient de la projection complète : on
     retire des points, on ne les redispose pas. */
  const shown = useMemo(() => {
    if (!data) return null
    const kept = new Set(posts.map((post) => post.id))
    return { ...data, points: data.points.filter((point) => kept.has(point.id)) }
  }, [data, posts])

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
  const heavy = posts.length > 15_000
  const estimate = Math.max(1, Math.round((26 * (posts.length / 9740) * Math.log2(Math.max(2, posts.length)) ) / Math.log2(9740) / 60))

  if (loading) {
    return (
      <div className="library-map__empty">
        <div className="organizer-spinner" />
        <p>{t('map.loading')}</p>
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
      {heavy ? (
        <p className="library-map__notice" role="status">
          {t('map.heavy', { count: posts.length, minutes: estimate })}
        </p>
      ) : null}
      <OrganizerMap
        data={shown}
        colourMode="group"
        includedGroups={includedGroups}
        groupNames={groupNames}
        showLabels
        showBoundaries={false}
        editMode={false}
        savedBoundaries={new Map()}
        onBoundaryChange={() => {}}
        onLasso={() => {}}
        onHover={() => {}}
        /* Un clic ouvre le post dans le panneau, comme dans l'organisateur. Le détail complet
           reste accessible depuis la grille : ici on veut regarder sans quitter la carte. */
        onOpen={(point) => setPanelPostId(point.id)}
        ownLabels={ownLabels}
        onPlaceLabel={(anchors) => {
          setNaming(anchors)
          setDraft('')
        }}
        detail={null}
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
            void magpie.saveMapLabel(id, text, naming).catch(() => {})
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
        </form>
      ) : null}
      <MapPostPanel postId={panelPostId} onClose={() => setPanelPostId(null)} />
    </div>
  )
}
