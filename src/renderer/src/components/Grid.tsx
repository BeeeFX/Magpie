import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Post } from '@shared/types'
import { magpie } from '../bridge'
import { computeLayout, visibleItems } from '../layout'
import { useStore, useT } from '../store'
import { Card } from './Card'

/** Gouttière généreuse : chaque image respire et se lit comme un objet à part entière,
 *  plutôt que comme une case dans un tableau. */
const GAP = 16

export function Grid(): React.JSX.Element {
  const t = useT()
  const posts = useStore((s) => s.posts)
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
  const [scroll, setScroll] = useState(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [resultsKey, setResultsKey] = useState(0)
  const [resizing, setResizing] = useState(false)
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

    const measure = (): void => {
      // `clientWidth` inclut le padding : la largeur utile est celle de la zone de
      // contenu, sinon les colonnes déborderaient de la largeur disponible.
      const style = getComputedStyle(el)
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const next = { width: Math.max(0, el.clientWidth - padX), height: el.clientHeight }
      setViewport((current) =>
        current.width === next.width && current.height === next.height ? current : next
      )
    }

    const scheduleMeasure = (): void => {
      if (!resizeFrame.current) {
        resizeFrame.current = requestAnimationFrame(() => {
          resizeFrame.current = 0
          measure()
        })
      }
      setResizing(true)
      if (resizeEnd.current !== null) clearTimeout(resizeEnd.current)
      resizeEnd.current = setTimeout(() => {
        resizeEnd.current = null
        setResizing(false)
      }, 120)
    }

    measure()

    // Trois filets, parce qu'une seule mesure ne suffit pas : la première passe de mise
    // en page peut annoncer une largeur nulle, et le `ResizeObserver` ne délivre rien
    // tant que la fenêtre n'est pas composited. Sans cela, la grille peut rester vide
    // jusqu'au premier redimensionnement.
    const deferred = [setTimeout(measure, 0), setTimeout(measure, 150)]
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
        containerWidth: viewport.width,
        targetColumnWidth: density,
        gap: GAP,
        mode
      }),
    [layoutRevision, viewport.width, density, mode]
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
    if (hasMore && !loadingMore && layout.totalHeight < scroll + viewport.height * 3) {
      void loadMore()
    }
  }, [hasMore, loadingMore, layout.totalHeight, scroll, viewport.height, loadMore])

  const postsById = useMemo(() => new Map(posts.map((post) => [post.id, post])), [posts])
  const visible = useMemo(
    () =>
      visibleItems(layout, scroll, viewport.height).map((item) => ({
        ...item,
        post: postsById.get(item.post.id) ?? item.post
      })),
    [layout, postsById, scroll, viewport.height]
  )
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const onCopy = useCallback((post: Post) => {
    void magpie.copyToClipboard(post.url)
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
          {accounts.some((a) => a.connected) ? (
            <p>{t('grid.noMatch')}</p>
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
