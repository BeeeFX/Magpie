import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Post } from '@shared/types'
import { magpie } from '../bridge'
import {
  alignItemsToPosts,
  computeLayout,
  neighbourItem,
  visibleItems,
  type Direction,
  type LayoutItem
} from '../layout'
import { reportFailure } from '../notices'
import type { TranslationKey } from '../i18n'
import { shouldPrefetch } from '../paging'
import { emptyReason } from '../query'
import { useStore, useT } from '../store'
import { Card } from './Card'

/** Gouttière généreuse : chaque image respire et se lit comme un objet à part entière,
 *  plutôt que comme une case dans un tableau. */
const GAP = 16

/** Marge de préparation autour du viewport, pendant le défilement puis une fois posé. */
const PREFETCH_MARGIN_MIN = 1200
const PREFETCH_MARGIN_MAX = 40000

/** Ce que l'écran vide dit, selon ce qui l'a vidé. */
const EMPTY_TEXT = {
  filters: 'grid.noMatch',
  favorites: 'grid.emptyFavorites',
  archived: 'grid.emptyArchived',
  collection: 'grid.emptyCollection',
  tag: 'grid.emptyTag',
  source: 'grid.emptySource'
} as const satisfies Record<string, TranslationKey>

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right'
}

/** Ce qui se parcourt déjà aux flèches, selon son rôle ARIA. */
const OWNS_ARROWS =
  '[role="toolbar"], [role="separator"], [role="slider"], [role="tablist"], ' +
  '[role="radiogroup"], [role="listbox"]'

/** Un champ garde ses touches : `Ctrl+A` y sélectionne le texte, les flèches y déplacent le
 *  curseur ou changent une valeur. */
function isTyping(element: HTMLElement): boolean {
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

export function Grid(): React.JSX.Element {
  const t = useT()
  const posts = useStore((s) => s.posts)
  const clearFilters = useStore((s) => s.clearFilters)
  const resetQuery = useStore((s) => s.resetQuery)
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

  const query = useStore((s) => s.query)
  /* Ce qui a vidé l'écran décide de la sortie qu'on propose. */
  const empty = emptyReason(query)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
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

  /* Un autre filtre, tri ou disposition : un autre mur, qui commence en haut. Le store remet
     bien `scrollTop` à zéro, mais seule la restauration initiale écrit dans l'élément — on
     restait au même décalage en pixels, au milieu des nouveaux résultats, les premiers hors
     de vue au-dessus. Comparé à la valeur précédente plutôt qu'à « premier passage » :
     StrictMode rejoue les effets au montage, et la restauration n'y survivrait pas. */
  const shown = useRef({ query, mode })
  useLayoutEffect(() => {
    if (shown.current.query === query && shown.current.mode === mode) return
    shown.current = { query, mode }
    const element = scrollerRef.current
    if (!element) return
    element.scrollTop = 0
    setScroll(0)
  }, [query, mode])

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

  /** La dernière carte cliquée ou cochée : le point de départ d'un `Maj`+clic. */
  const anchor = useRef<string | null>(null)

  /* Une plage appartient aux résultats où on l'a tracée : un autre filtre repart sans ancre. */
  useEffect(() => {
    anchor.current = null
  }, [query])

  /* Ouvre la vue détaillée depuis la position exacte de la carte, pour qu'elle paraisse
     s'agrandir plutôt que de surgir au centre. Par identifiant : ne plus chercher la position
     rend aussi ce rappel stable, et `memo(Card)` n'est plus déjoué à chaque lot de posts. */
  const onOpen = useCallback(
    (post: Post, element: HTMLElement) => {
      anchor.current = post.id
      openDetail(post.id, element.getBoundingClientRect())
    },
    [openDetail]
  )

  /* La plage suit l'ordre du mur — celui de `posts`, que la mise en page empile dans l'ordre —
     et s'ajoute à ce qui est déjà coché plutôt que de le remplacer : c'est le geste qui
     pardonne, quand la sélection vient d'un `Ctrl+A` suivi de retouches. Elle ne couvre que
     ce qui est chargé, ce qui est aussi tout ce qu'on a pu voir entre les deux clics. */
  const onSelect = useCallback((id: string, how: 'toggle' | 'range') => {
    const state = useStore.getState()
    const from = anchor.current
    if (how === 'range' && from !== null && from !== id) {
      const order = state.posts.map((post) => post.id)
      const start = order.indexOf(from)
      const end = order.indexOf(id)
      if (start >= 0 && end >= 0) {
        state.selectIds(order.slice(Math.min(start, end), Math.max(start, end) + 1))
        return
      }
    }
    anchor.current = id
    if (how === 'range') {
      state.selectIds([id])
      return
    }
    if (!state.selectionMode) state.setSelectionMode(true)
    state.toggleSelected(id)
  }, [])

  /* Ce que le clavier lit à chaque touche, sans réabonner l'écouteur à chaque vignette. */
  const nav = useRef({ layout, itemsById })
  useLayoutEffect(() => {
    nav.current = { layout, itemsById }
  }, [layout, itemsById])

  /** La carte active entière à l'écran, avec une marge : on défile le strict nécessaire. */
  const reveal = useCallback((item: LayoutItem): void => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const offset = canvasRef.current?.offsetTop ?? 0
    const top = item.y + offset - GAP
    const bottom = item.y + offset + item.height + GAP
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      // Une carte plus haute que la fenêtre se montre par le haut.
      scroller.scrollTop = Math.min(top, bottom - scroller.clientHeight)
    }
  }, [])

  /**
   * Vrai tant que le clavier parcourt le mur. Le focus du DOM ne suffit pas à le dire : quand
   * une flèche fait défiler loin, l'ancienne carte est démontée avant que la nouvelle n'arrive,
   * le focus passe un instant par `<body>`, et la touche suivante d'une répétition se perdait.
   * Un clic ou un focus posé ailleurs y mettent fin.
   */
  const keyboardInWall = useRef(false)

  const focusItem = useCallback(
    (item: LayoutItem): void => {
      const state = useStore.getState()
      const id = item.post.id
      keyboardInWall.current = true
      // L'aperçu suit le focus, comme celui du survol suit la souris.
      if (state.previewId !== null) state.setPreviewId(id)
      state.setFocusedId(id)
      reveal(item)
      /* Déjà montée, la carte prend le focus tout de suite ; sinon elle le prendra en arrivant
         dans la fenêtre de rendu (voir Card). */
      scrollerRef.current
        ?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(id)}"] .card__open`)
        ?.focus({ preventScroll: true })
    },
    [reveal]
  )

  /** Un pas vers le bas demandé au bout de ce qui est chargé, joué à l'arrivée de la suite. */
  const pendingMove = useRef<{ from: string; direction: Direction } | null>(null)

  useEffect(() => {
    const pending = pendingMove.current
    if (!pending) return
    const from = itemsById.get(pending.from)
    if (!from || useStore.getState().focusedId !== pending.from) {
      pendingMove.current = null
      return
    }
    const next = neighbourItem(layout, from, pending.direction)
    if (next) {
      pendingMove.current = null
      focusItem(next)
    } else if (!hasMore && !loadingMore) {
      pendingMove.current = null
    }
  }, [layout, itemsById, hasMore, loadingMore, focusItem])

  /*
   * Le mur au clavier.
   *
   * La fiche des raccourcis le reconnaissait elle-même : sur le mur, seule l'Entrée faisait
   * quelque chose, et la sélection se faisait une carte à la fois. Sur la fenêtre plutôt que
   * sur la grille, pour que la première flèche entre dans le mur quand rien n'a le focus.
   *
   * Ce qui garde ses touches : un champ, un menu ouvert, une fenêtre modale, la vue détaillée —
   * qui a ses propres flèches. Et `Échap` ne quitte la sélection que depuis le mur ou la barre de
   * sélection : trois cents posts cochés ne se perdent pas sur une touche pressée ailleurs.
   */
  useEffect(() => {
    /**
     * D'où part la flèche. La carte qui a le focus, si elle l'a vraiment ; sinon, on entre dans
     * le mur sans encore bouger — sur la carte active si on la voit, celle du coin haut gauche
     * de ce qu'on voit sinon. La première touche montre où l'on est, la suivante déplace :
     * partir d'une carte cliquée il y a longtemps, sans anneau visible, faisait surgir le focus
     * là où l'on ne regardait pas.
     */
    const entryItem = (): { item: LayoutItem; active: boolean } | null => {
      const scroller = scrollerRef.current
      if (!scroller) return null
      const { layout: current, itemsById: byId } = nav.current
      const top = scroller.scrollTop - (canvasRef.current?.offsetTop ?? 0)
      const bottom = top + scroller.clientHeight
      const focusedId = useStore.getState().focusedId
      const focused = focusedId !== null ? byId.get(focusedId) : undefined
      if (focused && focused.y < bottom && focused.y + focused.height > top) {
        const holder = document.activeElement?.closest('[data-id]')
        return {
          item: focused,
          active: keyboardInWall.current || holder?.getAttribute('data-id') === focusedId
        }
      }
      const shown = visibleItems(current, top, scroller.clientHeight, 0)
      let best: LayoutItem | null = null
      for (const item of shown) {
        if (item.y < top) continue
        if (!best || item.x < best.x || (item.x === best.x && item.y < best.y)) best = item
      }
      const entry = best ?? shown[0]
      return entry ? { item: entry, active: false } : null
    }

    const move = (direction: Direction): void => {
      const entry = entryItem()
      if (!entry) return
      // La première flèche entre dans le mur là où l'on regarde, sans encore bouger.
      if (!entry.active) {
        focusItem(entry.item)
        return
      }
      const next = neighbourItem(nav.current.layout, entry.item, direction)
      if (next) {
        focusItem(next)
        return
      }
      const state = useStore.getState()
      if (direction === 'down' && state.hasMore) {
        pendingMove.current = { from: entry.item.post.id, direction }
        void state.loadMore()
      }
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey) return
      const state = useStore.getState()
      if (state.detailId !== null) return
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target && isTyping(target)) return
      const scroller = scrollerRef.current
      if (!scroller) return
      const onWall = !target || target === document.body || scroller.contains(target)

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'a') {
        /* Tout le résultat, pas la tranche chargée : c'est ce que fait déjà « Tout » dans la
           barre de sélection, qu'on n'avait aucun moyen d'atteindre sans la souris. */
        event.preventDefault()
        state.setSelectionMode(true)
        void state.selectAllResults()
        return
      }
      if (event.ctrlKey || event.metaKey) return

      /* Depuis la barre latérale ou la barre d'outils aussi : après un clic sur « Favoris », la
         première flèche entre dans le mur au lieu d'imposer de tabuler à travers toute
         l'interface. Sauf là où les flèches ont déjà un sens. */
      const direction = ARROWS[event.key]
      if (direction) {
        if (event.shiftKey || target?.closest(OWNS_ARROWS)) return
        event.preventDefault()
        move(direction)
        return
      }

      /* `Espace` sur une carte : l'aperçu, c'est-à-dire ce que fait le survol — la vidéo se
         lit, le carrousel défile. Le bouton l'aurait pris pour un clic et ouvert le post, ce
         que fait déjà l'Entrée. En sélection, on laisse le clic : il coche la carte. */
      if (event.key === ' ' && !event.shiftKey && target?.classList.contains('card__open')) {
        if (state.selectionMode) return
        const id = target.closest('[data-id]')?.getAttribute('data-id') ?? null
        if (id === null) return
        event.preventDefault()
        // Une touche tenue ne fait pas clignoter l'aperçu.
        if (event.repeat) return
        state.setFocusedId(id)
        state.setPreviewId(state.previewId === id ? null : id)
        return
      }

      if (event.key === 'Escape') {
        if (state.previewId !== null) {
          state.setPreviewId(null)
          return
        }
        if (!onWall && !target?.closest('.bulk-bar')) return
        if (state.selectionMode) {
          state.setSelectionMode(false)
          return
        }
        if (state.focusedId !== null) {
          state.setFocusedId(null)
          if (target && scroller.contains(target)) target.blur()
        }
      }
    }

    const leaveWall = (event: Event): void => {
      if (event.type === 'focusin' && scrollerRef.current?.contains(event.target as Node)) return
      keyboardInWall.current = false
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('focusin', leaveWall)
    window.addEventListener('pointerdown', leaveWall, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focusin', leaveWall)
      window.removeEventListener('pointerdown', leaveWall, true)
    }
  }, [focusItem])

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
          ) : accounts.some((a) => a.connected) && empty.kind !== 'library' ? (
            /* La sortie doit correspondre à ce qui a vidé l'écran. Ce bouton était proposé
               **sans condition**, et il appelle `clearFilters`, qui garde délibérément la
               catégorie : sur une installation neuve, un clic sur « Favoris » — zéro favori —
               donnait « Aucun signet ne correspond à ces filtres » et un bouton incapable
               d'en sortir, puisqu'aucun filtre n'était posé. */
            <div className="empty-state empty-state--tight">
              <p>{t(EMPTY_TEXT[empty.kind === 'filters' ? 'filters' : empty.axis])}</p>
              {empty.kind === 'filters' ? (
                <button type="button" className="btn" onClick={clearFilters}>
                  {t('grid.clearFilters')}
                </button>
              ) : (
                <button type="button" className="btn" onClick={resetQuery}>
                  {t('grid.showAll')}
                </button>
              )}
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
        ref={canvasRef}
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
            onSelect={onSelect}
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
