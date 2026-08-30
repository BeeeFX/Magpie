import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Post } from '@shared/types'
import { magpie } from '../bridge'
import { alignItemsToPosts, computeLayout, visibleItems } from '../layout'
import { reportFailure } from '../notices'
import { shouldPrefetch } from '../paging'
import { useStore, useT } from '../store'
import { Card } from './Card'

/** Gouttière généreuse : chaque image respire et se lit comme un objet à part entière,
 *  plutôt que comme une case dans un tableau. */
const GAP = 16

/** Marge de préparation autour du viewport, pendant le défilement puis une fois posé. */
const PREFETCH_MARGIN_MIN = 1200
const PREFETCH_MARGIN_MAX = 40000

export function Grid(): React.JSX.Element {
  const t = useT()
  const posts = useStore((s) => s.posts)
  const clearFilters = useStore((s) => s.clearFilters)
  const loadError = useStore((s) => s.loadError)
  const refresh = useStore((s) => s.refresh)
  const layoutRevision = useStore((s) => s.layoutRevision)
  const loading = useStore((s) => s.loading)
  const loadingMore = useStore((s) => s.loadingMore)
  const hasMore = useStore((s) => s.hasMore)
  const resultTotal = useStore((s) => s.resultTotal)
  const loadMore = useStore((s) => s.loadMore)
  const mode = useStore((s) => s.gridMode)
  const density = useStore((s) => s.density)
  const savedScrollTop = useStore((s) => s.scrollTop)
  const setScrollTop = useStore((s) => s.setScrollTop)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const nitrateEnabled = useStore((s) => s.nitrateEnabled)
  const openDetail = useStore((s) => s.openDetail)
  const accounts = useStore((s) => s.accounts)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectedIds = useStore((s) => s.selectedIds)
  const toggleSelected = useStore((s) => s.toggleSelected)

  const query = useStore((s) => s.query)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [layoutWidth, setLayoutWidth] = useState(0)
  const [layoutDensity, setLayoutDensity] = useState(density)
  const [scroll, setScroll] = useState(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [resultsKey, setResultsKey] = useState(0)
  const [windowResizing, setWindowResizing] = useState(false)
  const [densityChanging, setDensityChanging] = useState(false)
  const resizing = windowResizing || densityChanging
  const restored = useRef(false)
  const resizeFrame = useRef(0)
  const resizeEnd = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* Largeur et hauteur réelles du conteneur — la mise en page en dépend entièrement.
     On mesure une première fois de façon synchrone plutôt que d'attendre le premier
     callback de l'observer : celui-ci n'arrive pas tant que la fenêtre n'est pas
     composited, et une fenêtre démarrée minimisée afficherait alors une grille vide. */
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return

    const measure = (commitLayout = false): void => {
      // `clientWidth` inclut le padding : la largeur utile est celle de la zone de
      // contenu, sinon les colonnes déborderaient de la largeur disponible.
      const style = getComputedStyle(el)
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const next = { width: Math.max(0, el.clientWidth - padX), height: el.clientHeight }
      setViewport((current) =>
        current.width === next.width && current.height === next.height ? current : next
      )
      if (commitLayout) setLayoutWidth((current) => (current === next.width ? current : next.width))
    }

    const scheduleMeasure = (): void => {
      if (!resizeFrame.current) {
        resizeFrame.current = requestAnimationFrame(() => {
          resizeFrame.current = 0
          measure(false)
        })
      }
      setWindowResizing(true)
      if (resizeEnd.current !== null) clearTimeout(resizeEnd.current)
      resizeEnd.current = setTimeout(() => {
        resizeEnd.current = null
        // Recompose le mur une seule fois, avec la largeur finale. React regroupe ces
        // deux changements : les transitions sont donc actives au moment où les cartes
        // reçoivent leur nouvelle position, au lieu de poursuivre la fenêtre à chaque pixel.
        measure(true)
        setWindowResizing(false)
      }, 100)
    }

    measure(true)

    // Trois filets, parce qu'une seule mesure ne suffit pas : la première passe de mise
    // en page peut annoncer une largeur nulle, et le `ResizeObserver` ne délivre rien
    // tant que la fenêtre n'est pas composited. Sans cela, la grille peut rester vide
    // jusqu'au premier redimensionnement.
    const deferred = [setTimeout(() => measure(true), 0), setTimeout(() => measure(true), 150)]
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(el)
    window.addEventListener('resize', scheduleMeasure)

    return () => {
      for (const id of deferred) clearTimeout(id)
      cancelAnimationFrame(resizeFrame.current)
      if (resizeEnd.current !== null) clearTimeout(resizeEnd.current)
      observer.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [])

  /* Le curseur de densité peut émettre des dizaines de valeurs par seconde. On laisse
     son libellé suivre immédiatement le doigt, puis on effectue une seule recomposition
     animée lorsque le geste marque une courte pause. */
  useEffect(() => {
    if (density === layoutDensity) return
    setDensityChanging(true)
    const timer = setTimeout(() => {
      setLayoutDensity(density)
      setDensityChanging(false)
    }, 80)
    return () => clearTimeout(timer)
  }, [density, layoutDensity])

  /* Le scroll arrive à ~120 Hz : on ne remet à jour l'état qu'une fois par frame. */
  const frame = useRef(0)
  const onScroll = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const element = scrollerRef.current
      const top = element?.scrollTop ?? 0
      setScroll(top)
      if (
        element &&
        element.scrollHeight - top - element.clientHeight < element.clientHeight * 2.5
      ) {
        void loadMore()
      }
    })
  }, [loadMore])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  /* La persistance du scroll est débrayée du rendu : inutile d'écrire en localStorage
     soixante fois par seconde. */
  useEffect(() => {
    const id = setTimeout(() => setScrollTop(scroll), 250)
    return () => clearTimeout(id)
  }, [scroll, setScrollTop])

  /* `query` est remplacé par une nouvelle référence à chaque filtre, tri ou recherche —
     mais pas quand la bibliothèque se remplit en arrière-plan, ce qui évite de rejouer
     l'animation à chaque vignette produite pendant un sync. */
  useEffect(() => {
    setResultsKey((k) => k + 1)
  }, [query])

  /*
   * Une vignette terminée remplace le contenu d'une carte, mais ses dimensions restent
   * celles déjà réservées. La géométrie ne doit donc pas être recalculée pour les milliers
   * d'autres cartes à chaque progression du cache.
   */
  const layout = useMemo(
    () =>
      computeLayout(posts, {
        containerWidth: layoutWidth,
        targetColumnWidth: layoutDensity,
        gap: GAP,
        mode
      }),
    [layoutRevision, layoutWidth, layoutDensity, mode]
  )

  /* Restauration de la position, une seule fois, quand la mise en page est prête. */
  useLayoutEffect(() => {
    if (restored.current || layout.totalHeight === 0 || !scrollerRef.current) return
    if (savedScrollTop > layout.totalHeight - viewport.height && hasMore) {
      void loadMore()
      return
    }
    restored.current = true
    if (savedScrollTop > 0) {
      scrollerRef.current.scrollTop = Math.min(savedScrollTop, layout.totalHeight)
      setScroll(scrollerRef.current.scrollTop)
    }
  }, [layout.totalHeight, savedScrollTop, viewport.height, hasMore, loadMore])

  /* Sur un grand écran ou une grille très dense, le premier lot peut ne pas dépasser
     assez loin sous la fenêtre. On précharge avant que le bas devienne visible. */
  useEffect(() => {
    if (shouldPrefetch({ hasMore, loadingMore }, loading, layout.totalHeight, scroll, viewport.height)) {
      void loadMore()
    }
  }, [hasMore, loadingMore, loading, layout.totalHeight, scroll, viewport.height, loadMore])

  /* Une fois par lot, hors du chemin de défilement : voir `alignItemsToPosts`, dont
     l'identité stable est ce qui rend le `memo` de Card réellement efficace. */
  const itemsById = useMemo(() => alignItemsToPosts(layout, posts), [layout, posts])

  const visible = useMemo(
    () =>
      visibleItems(layout, scroll, viewport.height).map(
        (item) => itemsById.get(item.post.id) ?? item
      ),
    [itemsById, layout, scroll, viewport.height]
  )

  /* Le cache intelligent suit le viewport, mais bien plus largement que le rendu.
     Monter une carte coûte du DOM, demander sa vignette ne coûte qu'un identifiant dans un
     message : les deux n'ont aucune raison de partager la même marge. Avec les 400 px du
     rendu — une rangée à peine — le moindre coup de molette dépassait la zone préparée.

     La bande respire donc avec l'usage : étroite pendant qu'on défile, pour ne rien
     préparer de ce qu'on survole, puis doublée à intervalle régulier dès qu'on s'arrête,
     jusqu'à couvrir largement les alentours de l'endroit où l'on s'est posé. */
  const [prefetchMargin, setPrefetchMargin] = useState(PREFETCH_MARGIN_MIN)

  useEffect(() => {
    setPrefetchMargin(PREFETCH_MARGIN_MIN)
  }, [scroll, layoutWidth, layoutDensity, mode])

  useEffect(() => {
    if (prefetchMargin >= PREFETCH_MARGIN_MAX) return
    const timer = setTimeout(
      () => setPrefetchMargin((margin) => Math.min(PREFETCH_MARGIN_MAX, margin * 2)),
      700
    )
    return () => clearTimeout(timer)
  }, [prefetchMargin])

  const prefetchIds = useMemo(() => {
    const margin = Math.max(prefetchMargin, viewport.height * 1.5)
    const centre = scroll + viewport.height / 2
    return visibleItems(layout, scroll, viewport.height, margin)
      .filter((item) =>
        (itemsById.get(item.post.id) ?? item).post.media.some(
          (media) => media.thumbStatus === 'pending'
        )
      )
      // Le plus proche d'abord : la file traite les identifiants dans l'ordre reçu, et
      // c'est ce qu'on a sous les yeux qui doit se remplir en premier.
      .sort(
        (a, b) =>
          Math.abs(a.y + a.height / 2 - centre) - Math.abs(b.y + b.height / 2 - centre)
      )
      .map((item) => item.post.id)
      .slice(0, 1000)
  }, [itemsById, layout, prefetchMargin, scroll, viewport.height])

  useEffect(() => {
    if (prefetchIds.length === 0) return
    const timer = setTimeout(
      () => void magpie.requestThumbnails(prefetchIds).catch(reportFailure('notice.unexpected')), 80)
    return () => clearTimeout(timer)
  }, [prefetchIds])

  /* Préparer la vignette ne suffit pas à ce qu'elle s'affiche instantanément : le fichier a
     beau être sur le disque, son `<img>` n'est monté qu'à l'entrée dans la fenêtre de rendu,
     et c'est seulement là que Chromium le lit et le décode. D'où le bref scintillement en
     haut et en bas d'un mur pourtant entièrement préparé.

     On demande donc le décodage en avance, sur la même bande que le préchargement et sans
     monter le moindre nœud : à l'arrivée dans le viewport, l'image est déjà en mémoire et
     `watchImage` la trouve complète dès le montage. */
  const warmed = useRef(new Set<string>())
  useEffect(() => {
    const margin = Math.max(prefetchMargin, viewport.height * 1.5)
    // Le cache image de Chromium est borné de son côté ; ce registre ne sert qu'à ne pas
    // relancer cent fois la même requête.
    if (warmed.current.size > 4000) warmed.current.clear()
    for (const item of visibleItems(layout, scroll, viewport.height, margin)) {
      const url = (itemsById.get(item.post.id) ?? item).post.media[0]?.thumbUrl
      if (!url || warmed.current.has(url)) continue
      warmed.current.add(url)
      const image = new Image()
      image.decoding = 'async'
      image.src = url
    }
  }, [itemsById, layout, prefetchMargin, scroll, viewport.height])
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const onCopy = useCallback((post: Post) => {
    void magpie.copyToClipboard(post.url).catch(reportFailure('notice.copyFailed'))
    setCopiedId(post.id)
    setTimeout(() => setCopiedId((id) => (id === post.id ? null : id)), 1200)
  }, [])

  /* Ouvre la vue détaillée depuis la position exacte de la carte, pour qu'elle paraisse
     s'agrandir plutôt que de surgir au centre. */
  const onOpen = useCallback(
    (post: Post, element: HTMLElement) => {
      const index = posts.findIndex((p) => p.id === post.id)
      if (index >= 0) openDetail(index, element.getBoundingClientRect())
    },
    [posts, openDetail]
  )

  const onSendToNitrate = useCallback((post: Post) => {
    void magpie.sendToNitrate(post.url)
  }, [])

  return (
    <div className={`grid ${resizing ? 'is-resizing' : ''}`} ref={scrollerRef} onScroll={onScroll}>
      {posts.length === 0 && !loading ? (
        <div className="grid__empty">
          {loadError ? (
            /* Une panne de lecture n'est pas un filtre trop strict. Elle retombait pourtant sur
               le même message, avec un bouton qui n'y pouvait rien. */
            <div className="empty-state">
              <h2>{t('grid.loadErrorTitle')}</h2>
              <p>{t('grid.loadErrorText')}</p>
              <code className="empty-state__detail">{loadError}</code>
              <button type="button" className="btn btn--primary" onClick={() => void refresh(true)}>
                {t('grid.retry')}
              </button>
            </div>
          ) : accounts.some((a) => a.connected) ? (
            /* Une phrase sans issue : on ne se souvient pas toujours de ce qu'on a coché,
               et il fallait retrouver chaque filtre pour le décocher un par un. */
            <div className="empty-state empty-state--tight">
              <p>{t('grid.noMatch')}</p>
              <button type="button" className="btn" onClick={clearFilters}>
                {t('grid.clearFilters')}
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <h2>{t('grid.emptyTitle')}</h2>
              <p>{t('grid.emptyText')}</p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setSettingsOpen(true)}
              >
                {t('sync.connectAccount')}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {/* La clé change à chaque nouveau jeu de résultats : l'animation d'entrée rejoue,
          et le mur se repose au lieu de se substituer sèchement. */}
      <div
        key={resultsKey}
        className="grid__canvas grid__canvas--fresh"
        style={{ height: layout.totalHeight + (hasMore ? 64 : 0) }}
      >
        {visible.map((item) => (
          <Card
            key={item.post.id}
            item={item}
            mode={mode}
            copied={copiedId === item.post.id}
            nitrateEnabled={nitrateEnabled}
            onToggleFavorite={toggleFavorite}
            onCopy={onCopy}
            onOpen={onOpen}
            onSendToNitrate={onSendToNitrate}
            selectionMode={selectionMode}
            selected={selectedIdSet.has(item.post.id)}
            onToggleSelected={toggleSelected}
          />
        ))}
        {hasMore ? (
          <div className="grid__load-more" style={{ top: layout.totalHeight }} aria-live="polite">
            <span className="spinner" />
            <span>{posts.length} / {resultTotal}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
