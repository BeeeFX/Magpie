import { useCallback, useEffect, useRef } from 'react'
import { PLATFORMS } from '@shared/types'
import { magpie, magpieEvents } from './bridge'
import { Detail } from './components/Detail'
import { Grid } from './components/Grid'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { Welcome } from './components/Welcome'
import { AiOrganizer } from './components/AiOrganizer'
import { ExportPanel } from './components/ExportPanel'
import { useStore } from './store'

export function App(): React.JSX.Element {
  const refresh = useStore((s) => s.refresh)
  const refreshPosts = useStore((s) => s.refreshPosts)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const loadSettings = useStore((s) => s.loadSettings)
  const loadAccounts = useStore((s) => s.loadAccounts)
  const setSyncState = useStore((s) => s.setSyncState)
  const setAiProgress = useStore((s) => s.setAiProgress)
  const setIsDark = useStore((s) => s.setIsDark)
  const accent = useStore((s) => s.accent)
  const isDark = useStore((s) => s.isDark)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const detailIndex = useStore((s) => s.detailIndex)
  const onboardingDone = useStore((s) => s.onboardingDone)
  const settingsLoading = useStore((s) => s.settingsLoading)
  const lastRefresh = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSyncRevision = useRef('')
  const pendingPostIds = useRef(new Set<string>())
  const mediaRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aiOrganizerOpen = useStore((s) => s.organizerOpen)
  const setAiOrganizerOpen = useStore((s) => s.setOrganizerOpen)
  const openAiOrganizer = useCallback(() => {
    setSettingsOpen(false)
    setAiOrganizerOpen(true)
  }, [setSettingsOpen])
  const closeAiOrganizer = useCallback(() => setAiOrganizerOpen(false), [])

  useEffect(() => {
    void refresh(true)
    void loadSettings()
    void loadAccounts()
    void magpie.getSyncState().then(setSyncState)

    const refreshSoon = (): void => {
      const elapsed = Date.now() - lastRefresh.current
      if (elapsed >= 1000) {
        lastRefresh.current = Date.now()
        void refresh()
        return
      }
      if (refreshTimer.current !== null) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        lastRefresh.current = Date.now()
        void refresh()
      }, 1000 - elapsed)
    }

    const refreshNow = (): void => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
      lastRefresh.current = Date.now()
      void refresh(false, true)
    }

    const flushMediaRefresh = (): void => {
      mediaRefreshTimer.current = null
      if (pendingPostIds.current.size === 0) return
      const ids = [...pendingPostIds.current]
      pendingPostIds.current.clear()
      void refreshPosts(ids)
    }

    /* Le cache tourne en fond : la grille se remplit au fur et à mesure plutôt que
       d'attendre la fin. On limite quand même la cadence — recharger à chaque vignette
       ferait clignoter l'écran pour rien. */
    const offProgress = magpieEvents.onCacheProgress((progress) => {
      for (const id of progress.postIds ?? []) pendingPostIds.current.add(id)
      if (mediaRefreshTimer.current === null) {
        mediaRefreshTimer.current = setTimeout(flushMediaRefresh, 300)
      }
    })

    const offUpdated = magpieEvents.onLibraryUpdated(() => {
      if (mediaRefreshTimer.current !== null) clearTimeout(mediaRefreshTimer.current)
      flushMediaRefresh()
      refreshNow()
    })

    const offTheme = magpieEvents.onThemeChanged(setIsDark)
    const offSync = magpieEvents.onSyncState((state) => {
      setSyncState(state)
      // Chaque page est déjà écrite en base. Rafraîchir ici rend immédiatement visibles
      // les nouveaux posts, même avant que leurs vignettes soient mises en cache.
      const revision = PLATFORMS.map((platform) => {
        const progress = state.byPlatform[platform]
        return `${platform}:${progress.phase}:${progress.page}:${progress.added}`
      }).join('|')
      if (revision !== lastSyncRevision.current) {
        lastSyncRevision.current = revision
        refreshSoon()
      }
    })
    const offAi = magpieEvents.onAiTagProgress(setAiProgress)
    const offWindowInteraction = magpieEvents.onWindowInteraction((active) => {
      document.documentElement.classList.toggle('window-is-moving', active)
    })

    return () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current)
      if (mediaRefreshTimer.current !== null) clearTimeout(mediaRefreshTimer.current)
      offProgress()
      offUpdated()
      offTheme()
      offSync()
      offAi()
      offWindowInteraction()
      document.documentElement.classList.remove('window-is-moving')
    }
  }, [refresh, refreshPosts, loadSettings, loadAccounts, setIsDark, setSyncState, setAiProgress])

  /* Le thème effectif et l'accent sont posés sur <html> : tout le CSS s'y accroche, et
     un seul attribut suffit à basculer l'application entière. */
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = isDark ? 'dark' : 'light'
    root.dataset.accent = accent
    root.dataset.platform = magpie.platform
  }, [isDark, accent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.ctrlKey || e.metaKey
      if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
      if (meta && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar, setSettingsOpen])

  /* Tant que la présentation n'est pas terminée, elle occupe toute la fenêtre : le
     premier geste attendu est de connecter un compte, pas d'explorer une app vide. */
  if (!settingsLoading && !onboardingDone) return <Welcome />

  return (
    <div className={`app ${sidebarOpen ? '' : 'is-collapsed'}`}>
      <Sidebar />
      <main className="main">
        <Toolbar />
        <Grid />
      </main>
      {/* Monté seulement quand un post est ouvert : sinon le composant resterait en place
          avec son état local — dont l'indicateur de fermeture, qui rendait le panneau
          invisible à la réouverture. Le démontage garantit un état propre à chaque fois. */}
      {detailIndex !== null ? <Detail /> : null}
      <Settings onOpenAiOrganizer={openAiOrganizer} />
      <AiOrganizer open={aiOrganizerOpen} onClose={closeAiOrganizer} />
      <ExportPanel />
    </div>
  )
}
