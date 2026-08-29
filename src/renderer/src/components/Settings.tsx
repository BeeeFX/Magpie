import { useEffect, useRef, useState } from 'react'
import { useClosing } from '../useClosing'
import { useModalFocus } from '../useModalFocus'
import type {
  AiProvider,
  LanguageChoice,
  LibraryInfo,
  LibraryMoveProgress,
  PlaybackQuality,
  SyncSchedule,
  ThemeChoice,
  UpdateState,
  VideoQuality
} from '@shared/types'
import { ACCENTS, LANGUAGES } from '@shared/types'
import { magpie, magpieEvents } from '../bridge'
import { formatBytes } from '../format'
import { LANGUAGE_LABEL, type TranslationKey } from '../i18n'
import { DENSITY_MAX, DENSITY_MIN, useStore, useT } from '../store'
import { Accounts } from './Accounts'
import { IconCards, IconClose, IconMap, IconMasonry } from './Icons'

const THEMES: { key: ThemeChoice; label: TranslationKey }[] = [
  { key: 'system', label: 'settings.system' },
  { key: 'light', label: 'settings.light' },
  { key: 'dark', label: 'settings.dark' }
]

const AI_DEFAULT_MODEL: Record<AiProvider, string> = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-5',
  gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat',
  custom: ''
}

// Conservé derrière un drapeau pour une éventuelle reprise, mais absent du produit
// tant que l'organisateur local couvre correctement le besoin.
const LLM_SETTINGS_VISIBLE = false

export function Settings(): React.JSX.Element | null {
  const t = useT()
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const language = useStore((s) => s.language)
  const setLanguage = useStore((s) => s.setLanguage)
  const accent = useStore((s) => s.accent)
  const setAccent = useStore((s) => s.setAccent)
  const gridMode = useStore((s) => s.gridMode)
  const setGridMode = useStore((s) => s.setGridMode)
  const density = useStore((s) => s.density)
  const setDensity = useStore((s) => s.setDensity)
  const nitrateEnabled = useStore((s) => s.nitrateEnabled)
  const setNitrateEnabled = useStore((s) => s.setNitrateEnabled)
  const contentSources = useStore((s) => s.contentSources)
  const setContentSources = useStore((s) => s.setContentSources)
  const videoCacheQuality = useStore((s) => s.videoCacheQuality)
  const setVideoCacheQuality = useStore((s) => s.setVideoCacheQuality)
  const mediaStorageMode = useStore((s) => s.mediaStorageMode)
  const setMediaStorageMode = useStore((s) => s.setMediaStorageMode)
  const playbackQuality = useStore((s) => s.playbackQuality)
  const setPlaybackQuality = useStore((s) => s.setPlaybackQuality)
  const cacheLimitGb = useStore((s) => s.cacheLimitGb)
  const setCacheLimitGb = useStore((s) => s.setCacheLimitGb)
  const trayEnabled = useStore((s) => s.trayEnabled)
  const setTrayEnabled = useStore((s) => s.setTrayEnabled)
  const syncOnLaunch = useStore((s) => s.syncOnLaunch)
  const setSyncOnLaunch = useStore((s) => s.setSyncOnLaunch)
  const syncSchedule = useStore((s) => s.syncSchedule)
  const setSyncSchedule = useStore((s) => s.setSyncSchedule)
  const autoOrganizeEnabled = useStore((s) => s.autoOrganizeEnabled)
  const setAutoOrganizeEnabled = useStore((s) => s.setAutoOrganizeEnabled)
  const aiProvider = useStore((s) => s.aiProvider)
  const aiModel = useStore((s) => s.aiModel)
  const aiEndpoint = useStore((s) => s.aiEndpoint)
  const autoTagEnabled = useStore((s) => s.autoTagEnabled)
  const aiProgress = useStore((s) => s.aiProgress)
  const setAiSettings = useStore((s) => s.setAiSettings)
  const replayOnboarding = useStore((s) => s.replayOnboarding)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const loadAccounts = useStore((s) => s.loadAccounts)
  const refresh = useStore((s) => s.refresh)

  const [info, setInfo] = useState<LibraryInfo | null>(null)
  const [clearing, setClearing] = useState(false)
  const [cacheError, setCacheError] = useState<string | null>(null)
  const [aiKey, setAiKey] = useState('')
  const [aiKeyStored, setAiKeyStored] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [libraryMove, setLibraryMove] = useState<LibraryMoveProgress | null>(null)
  const [choosingLibrary, setChoosingLibrary] = useState(false)
  const [libraryMoveError, setLibraryMoveError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /* Le store se ferme tout de suite, mais le panneau reste monté le temps de revenir
     doucement vers l'arrière-plan. */
  const { mounted, closing } = useClosing(open, 230)

  useEffect(() => {
    if (!open) return
    void magpie.getLibraryInfo().then(setInfo)
    void magpie.getUpdateState().then(setUpdateState)
    void loadAccounts()
  }, [open, loadAccounts])

  useEffect(() => {
    if (!open) return
    return magpieEvents.onUpdateState(setUpdateState)
  }, [open])

  useEffect(() => {
    return magpieEvents.onLibraryMoveProgress((progress) => {
      setLibraryMove(progress)
      if (progress.phase === 'error') setLibraryMoveError(progress.message)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    void magpie.hasAiKey(aiProvider).then(setAiKeyStored)
  }, [open, aiProvider])

  /* Le piège de tabulation, l’entrée du focus et son retour vivent dans `useModalFocus` :
     trois fenêtres les demandent, et seule celle-ci les avait. `Échap` reste ici. */
  useModalFocus(open, panelRef)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!mounted) return null

  const clearCache = async (): Promise<void> => {
    setClearing(true)
    setCacheError(null)
    try {
      const result = await magpie.clearMediaCache()
      // Un fichier encore ouvert — le clip qu'on vient de regarder — résiste à sa
      // suppression. Le dire vaut mieux que d'afficher une purge complète qui ne l'est pas.
      if (result.failed > 0) setCacheError(t('settings.cachePartial', { count: result.failed }))
      setInfo(await magpie.getLibraryInfo())
      await refresh()
    } catch (reason) {
      setCacheError(reason instanceof Error ? reason.message : t('settings.cacheError'))
    } finally {
      // Sans ce `finally`, la moindre erreur laissait le bouton désactivé sur « Purge… »
      // définitivement, sans le moindre message.
      setClearing(false)
    }
  }

  const moveLibrary = async (): Promise<void> => {
    setChoosingLibrary(true)
    setLibraryMoveError(null)
    try {
      const result = await magpie.chooseLibraryFolder()
      if (!result.moved) setLibraryMove(null)
    } catch (error) {
      setLibraryMoveError(error instanceof Error ? error.message : String(error))
    } finally {
      setChoosingLibrary(false)
    }
  }

  const languages: { key: LanguageChoice; label: string }[] = [
    { key: 'system', label: t('settings.system') },
    ...LANGUAGES.map((code) => ({ key: code as LanguageChoice, label: LANGUAGE_LABEL[code] }))
  ]
  const cacheQualities: VideoQuality[] = ['480p', '720p', '1080p', 'source']
  const playbackQualities: PlaybackQuality[] = ['auto', ...cacheQualities]
  const schedules: SyncSchedule[] = ['manual', 'hourly', '6h', 'daily']
  const aiProviders: AiProvider[] = ['openai', 'anthropic', 'gemini', 'deepseek', 'custom']

  return (
    <div
      className={`modal ${closing ? 'is-closing' : ''}`}
      onMouseDown={() => setOpen(false)}
    >
      <div
        ref={panelRef}
        className="modal__panel"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="modal__head">
          <h2 id="settings-title">{t('settings.title')}</h2>
          <button
            type="button"
            className="icon-btn-ghost"
            onClick={() => setOpen(false)}
            aria-label={t('settings.close')}
          >
            <IconClose />
          </button>
        </header>

        <div className="modal__body">
          <section className="setting setting--stack">
            <div className="setting__label">
              <h3>{t('settings.accounts')}</h3>
              <p>{t('settings.accountsHint')}</p>
            </div>
            <Accounts />
            <div className="setting setting--compact">
              <div className="setting__label">
                <strong>{t('settings.sources')}</strong>
                <span>{t('settings.sourcesHint')}</span>
              </div>
              <div className="segmented segmented--wide">
                <button
                  type="button"
                  className={contentSources.length === 1 && contentSources[0] === 'saved' ? 'is-active' : ''}
                  onClick={() => void setContentSources(['saved'])}
                >{t('source.savedOnly')}</button>
                <button
                  type="button"
                  className={contentSources.length === 1 && contentSources[0] === 'liked' ? 'is-active' : ''}
                  onClick={() => void setContentSources(['liked'])}
                >{t('source.likedOnly')}</button>
                <button
                  type="button"
                  className={contentSources.length === 2 ? 'is-active' : ''}
                  onClick={() => void setContentSources(['saved', 'liked'])}
                >{t('source.both')}</button>
              </div>
            </div>
          </section>

          <div className="modal__sep" />

          <section className="setting setting--stack">
            <div className="setting__label">
              <h3>{t('settings.localOrganizer')}</h3>
              <p>{t('settings.localOrganizerHint')}</p>
            </div>
            {/* Le bouton d'organisation vivait aussi ici. Deux portes vers le même écran, dont
                une enfouie dans les réglages : celle de la barre du haut suffit, et les
                réglages ne gardent que ce qui se règle. */}
            <div className="setting setting--compact">
              <div className="setting__label">
                <strong>{t('settings.autoOrganize')}</strong>
                <span>{t('settings.autoOrganizeHint')}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoOrganizeEnabled}
                className={`switch ${autoOrganizeEnabled ? 'is-on' : ''}`}
                onClick={() => void setAutoOrganizeEnabled(!autoOrganizeEnabled)}
              >
                <span className="switch__knob" />
              </button>
            </div>
            <p className="setting__note">{t('settings.localOrganizerNote')}</p>
          </section>

          <div className="modal__sep" />

          <section className="setting setting--stack">
            <div className="setting__label">
              <h3>{t('settings.background')}</h3>
              <p>{t('settings.backgroundHint')}</p>
            </div>
            <div className="segmented segmented--wide">
              {schedules.map((schedule) => (
                <button
                  key={schedule}
                  type="button"
                  className={syncSchedule === schedule ? 'is-active' : ''}
                  onClick={() => void setSyncSchedule(schedule)}
                >
                  {t(`schedule.${schedule}` as TranslationKey)}
                </button>
              ))}
            </div>
            <div className="setting setting--compact">
              <div className="setting__label">
                <strong>{t('settings.syncOnLaunch')}</strong>
                <span>{t('settings.syncOnLaunchHint')}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={syncOnLaunch}
                className={`switch ${syncOnLaunch ? 'is-on' : ''}`}
                onClick={() => void setSyncOnLaunch(!syncOnLaunch)}
              >
                <span className="switch__knob" />
              </button>
            </div>
            <div className="setting setting--compact">
              <div className="setting__label">
                <strong>{t('settings.tray')}</strong>
                <span>{t('settings.trayHint')}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={trayEnabled}
                className={`switch ${trayEnabled ? 'is-on' : ''}`}
                onClick={() => void setTrayEnabled(!trayEnabled)}
              >
                <span className="switch__knob" />
              </button>
            </div>
          </section>

          <div className="modal__sep" />

          <section className="setting setting--stack">
            <div className="setting__label">
              <h3>{t('settings.video')}</h3>
              <p>{t('settings.videoHint')}</p>
            </div>
            <div className="setting setting--compact">
              <div className="setting__label">
                <strong>{t('settings.storageMode')}</strong>
                <span>{t(`settings.storageMode.${mediaStorageMode}Hint`)}</span>
              </div>
              <div className="segmented segmented--wide">
                {(['stream', 'offline'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={mediaStorageMode === mode ? 'is-active' : ''}
                    onClick={() => void setMediaStorageMode(mode)}
                  >
                    {t(`settings.storageMode.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
            {/* Visible dans les deux modes : depuis que le menu d'actions permet de
                télécharger les vidéos sans basculer en hors-ligne, ce réglage compte partout.
                Caché, il laissait un choix fait au premier lancement impossible à revenir. */}
            <div className="setting setting--compact">
                <div className="setting__label">
                  <strong>{t('settings.cacheQuality')}</strong>
                  <p>{t('settings.cacheQualityHint')}</p>
                </div>
                <div className="segmented segmented--wide">
                  {cacheQualities.map((quality) => (
                    <button
                      key={quality}
                      type="button"
                      className={videoCacheQuality === quality ? 'is-active' : ''}
                      onClick={() => void setVideoCacheQuality(quality)}
                    >
                      {t(`quality.${quality}` as TranslationKey)}
                    </button>
                  ))}
                </div>
            </div>
            <div className="setting setting--compact">
              <div className="setting__label">
                <strong>{t('settings.playbackQuality')}</strong>
              </div>
              <div className="segmented segmented--wide">
                {playbackQualities.map((quality) => (
                  <button
                    key={quality}
                    type="button"
                    className={playbackQuality === quality ? 'is-active' : ''}
                    onClick={() => void setPlaybackQuality(quality)}
                  >
                    {t(`quality.${quality}` as TranslationKey)}
                  </button>
                ))}
              </div>
            </div>
            <label className="setting setting--compact">
              <div className="setting__label">
                <strong>{t('settings.cacheLimit')}</strong>
                <span>{cacheLimitGb} Go</span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={cacheLimitGb}
                onChange={(event) => void setCacheLimitGb(Number(event.target.value))}
              />
            </label>
          </section>

          <div className="modal__sep" />

          <section className="setting">
            <div className="setting__label">
              <h3>{t('settings.language')}</h3>
              <p>{t('settings.languageHint')}</p>
            </div>
            <div className="segmented segmented--wide">
              {languages.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  className={language === l.key ? 'is-active' : ''}
                  onClick={() => void setLanguage(l.key)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </section>

          <section className="setting">
            <div className="setting__label">
              <h3>{t('settings.theme')}</h3>
              <p>{t('settings.themeHint')}</p>
            </div>
            <div className="segmented segmented--wide">
              {THEMES.map((th) => (
                <button
                  key={th.key}
                  type="button"
                  className={theme === th.key ? 'is-active' : ''}
                  onClick={() => void setTheme(th.key)}
                >
                  {t(th.label)}
                </button>
              ))}
            </div>
          </section>

          <section className="setting">
            <div className="setting__label">
              <h3>{t('settings.accent')}</h3>
              <p>{t('settings.accentHint')}</p>
            </div>
            <div className="swatches">
              {ACCENTS.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`swatch swatch--${name} ${accent === name ? 'is-active' : ''}`}
                  title={t(`accent.${name}` as TranslationKey)}
                  aria-label={t(`accent.${name}` as TranslationKey)}
                  onClick={() => void setAccent(name)}
                />
              ))}
            </div>
          </section>

          <div className="modal__sep" />

          <section className="setting">
            <div className="setting__label">
              <h3>{t('settings.gridDisplay')}</h3>
              <p>{t('settings.gridHint')}</p>
            </div>
            <div className="segmented">
              <button
                type="button"
                className={gridMode === 'masonry' ? 'is-active' : ''}
                onClick={() => setGridMode('masonry')}
              >
                <IconMasonry />
                <span>{t('settings.masonry')}</span>
              </button>
              <button
                type="button"
                className={gridMode === 'cards' ? 'is-active' : ''}
                onClick={() => setGridMode('cards')}
              >
                <IconCards />
                <span>{t('settings.cards')}</span>
              </button>
              {/* Le troisième mode existait dans la barre d'outils et pas ici : ce réglage
                  prétendait pourtant montrer les dispositions, et il en cachait une. */}
              <button
                type="button"
                className={gridMode === 'map' ? 'is-active' : ''}
                onClick={() => setGridMode('map')}
              >
                <IconMap size={16} />
                <span>{t('settings.map')}</span>
              </button>
            </div>
          </section>

          <section className="setting">
            <div className="setting__label">
              <h3>{t('settings.density')}</h3>
              <p>{t('settings.densityHint', { width: density })}</p>
            </div>
            <label className="density density--wide">
              <span className="density__cap density__cap--lg" />
              <input
                type="range"
                min={DENSITY_MIN}
                max={DENSITY_MAX}
                step={10}
                value={DENSITY_MAX + DENSITY_MIN - density}
                onChange={(e) => setDensity(DENSITY_MAX + DENSITY_MIN - Number(e.target.value))}
              />
              <span className="density__cap density__cap--sm" />
            </label>
          </section>

          <div className="modal__sep" />

          <section className="setting">
            <div className="setting__label">
              <h3>{t('settings.nitrate')}</h3>
              <p>
                {t('settings.nitrateHint')}
                {magpie.platform !== 'win32' ? t('settings.nitrateWindowsOnly') : ''}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={nitrateEnabled}
              className={`switch ${nitrateEnabled ? 'is-on' : ''}`}
              onClick={() => void setNitrateEnabled(!nitrateEnabled)}
            >
              <span className="switch__knob" />
            </button>
          </section>

          <div className="modal__sep" />

          <section className="setting setting--stack">
            <div className="setting__label">
              <h3>{t('settings.library')}</h3>
              <p>
                {info
                  ? t('settings.libraryStats', {
                      posts: info.posts,
                      media: info.media,
                      size: formatBytes(info.cacheBytes)
                    })
                  : '…'}
              </p>
            </div>
            <div className="library-location">
              <span>{t('settings.libraryLocation')}</span>
              <code title={info?.dataPath}>{info?.dataPath ?? '…'}</code>
            </div>
            {libraryMove && libraryMove.phase !== 'error' ? (
              <div className="library-move" aria-live="polite">
                <div className="library-move__status">
                  <span className="spinner" />
                  <strong>
                    {t(`settings.libraryMove.${libraryMove.phase}` as TranslationKey)}
                  </strong>
                  {libraryMove.total > 0 ? (
                    <span>{Math.min(100, Math.round((libraryMove.done / libraryMove.total) * 100))}%</span>
                  ) : null}
                </div>
                <div
                  className="library-move__progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    libraryMove.total > 0
                      ? Math.min(100, Math.round((libraryMove.done / libraryMove.total) * 100))
                      : undefined
                  }
                >
                  <span
                    style={{
                      width: `${
                        libraryMove.total > 0
                          ? Math.min(100, (libraryMove.done / libraryMove.total) * 100)
                          : 8
                      }%`
                    }}
                  />
                </div>
                <code title={libraryMove.path}>{libraryMove.path}</code>
              </div>
            ) : null}
            {libraryMoveError ? (
              <p className="setting__error" role="alert">{libraryMoveError}</p>
            ) : null}
            <div className="setting__actions">
              <button
                type="button"
                className="btn"
                disabled={choosingLibrary || (libraryMove !== null && libraryMove.phase !== 'error')}
                onClick={() => void magpie.openDataFolder()}
              >
                {t('settings.openFolder')}
              </button>
              <button
                type="button"
                className="btn"
                disabled={choosingLibrary || (libraryMove !== null && libraryMove.phase !== 'error')}
                onClick={() => void moveLibrary()}
              >
                {choosingLibrary ? t('settings.choosingLibrary') : t('settings.moveLibrary')}
              </button>
              <button
                type="button"
                className="btn"
                /* Le geste le plus destructeur de cet écran partait au premier clic, alors
                   que « Tout revérifier », qui ne supprime rien, demandait confirmation.
                   L'avertissement dit ce qui va réellement se passer, pas seulement que
                   c'est irréversible. */
                onClick={() => {
                  if (window.confirm(t('settings.clearCacheConfirm'))) void clearCache()
                }}
                disabled={clearing || choosingLibrary || (libraryMove !== null && libraryMove.phase !== 'error')}
              >
                {clearing ? t('settings.clearing') : t('settings.clearCache')}
              </button>
            </div>
            {cacheError ? (
              <p className="setting__error" role="alert">{cacheError}</p>
            ) : null}
            <p className="setting__note">{t('settings.cacheNote')}</p>
            {/* Deux boutons vivaient ici, « Images des tuiles » et « Vidéos en 480p », qui
                relançaient à la main exactement ce que le menu de synchronisation fait
                désormais tout seul. Ils ne disaient rien de plus que le compteur au-dessus
                d'eux, et le plus souvent restaient éteints faute d'avoir quoi que ce soit à
                préparer : deux commandes qui ne servent que dans le cas rare où l'on refuse
                l'automatisme, à l'endroit où personne ne les cherche. */}
          </section>

          <div className="modal__sep" />

          <section className="setting setting--stack">
            <div className="setting__label">
              <h3>{t('settings.updates')}</h3>
              <p>{t('settings.updatesHint')}</p>
            </div>
            <div className="update-card" aria-live="polite">
              <div className="update-card__status">
                <strong>
                  {updateState
                    ? t(`update.status.${updateState.phase}` as TranslationKey, {
                        version: updateState.availableVersion ?? updateState.currentVersion,
                        percent: Math.round(updateState.percent ?? 0)
                      })
                    : '…'}
                </strong>
                <span>
                  {t('update.currentVersion', {
                    version: updateState?.currentVersion ?? info?.version ?? '…'
                  })}
                </span>
              </div>
              {updateState?.phase === 'downloading' ? (
                <div
                  className="update-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(updateState.percent ?? 0)}
                >
                  <span style={{ width: `${updateState.percent ?? 0}%` }} />
                </div>
              ) : null}
              <button
                type="button"
                className={`btn ${updateState?.phase === 'ready' ? 'btn--primary' : ''}`}
                disabled={
                  !updateState ||
                  updateState.phase === 'checking' ||
                  updateState.phase === 'available' ||
                  updateState.phase === 'downloading' ||
                  updateState.phase === 'unsupported'
                }
                onClick={() => {
                  if (updateState?.phase === 'ready') void magpie.installUpdate()
                  else void magpie.checkForUpdates().then(setUpdateState)
                }}
              >
                {updateState?.phase === 'ready'
                  ? t('update.install')
                  : updateState?.phase === 'checking'
                    ? t('update.checking')
                    : updateState?.phase === 'downloading'
                      ? t('update.downloading', {
                          percent: Math.round(updateState.percent ?? 0)
                        })
                      : t('update.check')}
              </button>
            </div>
          </section>

          <div className="modal__sep" />

          <section className="setting setting--stack">
            <div className="setting__label">
              <h3>{t('settings.guide')}</h3>
              <p>{t('settings.guideHint')}</p>
            </div>
            <div className="setting__actions">
              <button type="button" className="btn" onClick={() => void replayOnboarding()}>
                {t('settings.replayTour')}
              </button>
              {/* Deux portes vers la liste : « ? » pour qui connaît la convention, celle-ci
                  pour les autres. Fermer les réglages d'abord — deux modales empilées ne se
                  ferment plus dans le bon ordre. */}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOpen(false)
                  setShortcutsOpen(true)
                }}
              >
                {t('shortcuts.open')}
              </button>
            </div>
          </section>

          {LLM_SETTINGS_VISIBLE ? <>
          <div className="modal__sep" />

          <section className="setting setting--stack">
            <div className="setting__label">
              <h3>{t('settings.ai')}</h3>
              <p>{t('settings.aiHint')}</p>
            </div>
            <div className="segmented segmented--wide">
              {aiProviders.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  className={aiProvider === provider ? 'is-active' : ''}
                  onClick={() =>
                    void setAiSettings({ aiProvider: provider, aiModel: AI_DEFAULT_MODEL[provider] })
                  }
                >
                  {t(`ai.${provider}` as TranslationKey)}
                </button>
              ))}
            </div>
            <label className="settings-field">
              <span>{t('settings.aiModel')}</span>
              <input
                value={aiModel}
                onChange={(event) => void setAiSettings({ aiModel: event.target.value })}
                placeholder="gpt-4.1-mini"
              />
            </label>
            {aiProvider === 'custom' ? (
              <label className="settings-field">
                <span>{t('settings.aiEndpoint')}</span>
                <input
                  value={aiEndpoint}
                  onChange={(event) => void setAiSettings({ aiEndpoint: event.target.value })}
                  placeholder="https://…/v1/chat/completions"
                />
              </label>
            ) : null}
            <label className="settings-field">
              <span>{t('settings.aiKey')}</span>
              <div className="settings-field__row">
                <input
                  type="password"
                  value={aiKey}
                  onChange={(event) => setAiKey(event.target.value)}
                  placeholder={aiKeyStored ? t('settings.aiKeyStored') : 'sk-…'}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!aiKey.trim()}
                  onClick={() =>
                    void magpie.setAiKey(aiProvider, aiKey).then(() => {
                      setAiKey('')
                      setAiKeyStored(true)
                    })
                  }
                >
                  {t('settings.save')}
                </button>
              </div>
            </label>
            <div className="setting setting--compact">
              <div className="setting__label">
                <strong>{t('settings.autoTag')}</strong>
                <span>{t('settings.autoTagHint')}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoTagEnabled}
                className={`switch ${autoTagEnabled ? 'is-on' : ''}`}
                onClick={() => void setAiSettings({ autoTagEnabled: !autoTagEnabled })}
              >
                <span className="switch__knob" />
              </button>
            </div>
            <div className="setting__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!aiKeyStored || aiProgress?.running}
                onClick={() => void magpie.startAiTagging()}
              >
                {aiProgress?.running
                  ? t('settings.aiProgress', { done: aiProgress.done, total: aiProgress.total })
                  : t('settings.aiRun')}
              </button>
            </div>
            <p className="setting__note">{t('settings.aiPrivacy')}</p>
          </section>
          </> : null}
        </div>

        <footer className="modal__foot">
          <span>
            {t('app.name')} {info?.version ?? ''}
          </span>
          <span className="modal__path" title={info?.dataPath}>
            {info?.dataPath}
          </span>
        </footer>
      </div>
    </div>
  )
}
