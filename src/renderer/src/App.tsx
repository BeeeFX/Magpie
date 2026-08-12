import { useCallback, useEffect, useRef, useState } from 'react'
import { magpie, magpieEvents } from './bridge'
import { Detail } from './components/Detail'
import { Grid } from './components/Grid'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { Welcome } from './components/Welcome'
import { AiOrganizer } from './components/AiOrganizer'
import { useStore } from './store'

export function App(): React.JSX.Element {
  const refresh = useStore((s) => s.refresh)
  const setCacheProgress = useStore((s) => s.setCacheProgress)
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
  const [aiOrganizerOpen, setAiOrganizerOpen] = useState(false)
  const openAiOrganizer = useCallback(() => {
    setSettingsOpen(false)
    setAiOrganizerOpen(true)
  }, [setSettingsOpen])
  const closeAiOrganizer = useCallback(() => setAiOrganizerOpen(false), [])

  useEffect(() => {
    void refresh()
    void loadSettings()
    void loadAccounts()

    /* Le cache tourne en fond : la grille se remplit au fur et à mesure plutôt que
       d'attendre la fin. On limite quand même la cadence — recharger à chaque vignette
       ferait clignoter l'écran pour rien. */
    const offProgress = magpieEvents.onCacheProgress((progress) => {
      setCacheProgress(progress)
      const now = Date.now()
      if (now - lastRefresh.current > 700) {
        lastRefresh.current = now
        void refresh()
      }
    })

    const offUpdated = magpieEvents.onLibraryUpdated(() => {
      setCacheProgress(null)
      void refresh()
    })

    const offTheme = magpieEvents.onThemeChanged(setIsDark)
    const offSync = magpieEvents.onSyncState(setSyncState)
    const offAi = magpieEvents.onAiTagProgress(setAiProgress)

    return () => {
      offProgress()
      offUpdated()
      offTheme()
      offSync()
      offAi()
    }
  }, [refresh, loadSettings, loadAccounts, setCacheProgress, setIsDark, setSyncState, setAiProgress])

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
    </div>
  )
}
