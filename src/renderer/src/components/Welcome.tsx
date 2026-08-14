import { useEffect, useState } from 'react'
import { ACCENTS, LANGUAGES } from '@shared/types'
import type { LibraryInfo, VideoQuality } from '@shared/types'
import { magpie } from '../bridge'
import { LANGUAGE_LABEL, type TranslationKey } from '../i18n'
import { useStore, useT } from '../store'
import { Accounts } from './Accounts'
import { Logo } from './Logo'
import {
  IconChevronLeft,
  IconCheck,
  IconCollections,
  IconGrid,
  IconInbox,
  IconSearch,
  IconSend,
  IconStar,
  IconSync,
  IconTag
} from './Icons'

/**
 * Présentation du premier lancement.
 *
 * Elle remplace l'application tant qu'elle n'est pas terminée. Le parti pris : une
 * bibliothèque vide vaut mieux qu'une bibliothèque de faux posts — des données inventées
 * ne montrent pas ce que fait l'outil, elles le miment, et elles brouillent le seul geste
 * qui compte au départ, connecter un compte.
 *
 * La langue et la couleur se choisissent dès le premier écran : ce sont les deux réglages
 * qu'on veut poser avant de lire quoi que ce soit, pas après.
 */

function Feature({
  icon,
  title,
  text
}: {
  icon: React.JSX.Element
  title: string
  text: string
}): React.JSX.Element {
  return (
    <div className="feature">
      <span className="feature__icon">{icon}</span>
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </div>
  )
}

export function Welcome(): React.JSX.Element {
  const t = useT()
  const accounts = useStore((s) => s.accounts)
  const finishOnboarding = useStore((s) => s.finishOnboarding)
  const language = useStore((s) => s.language)
  const setLanguage = useStore((s) => s.setLanguage)
  const accent = useStore((s) => s.accent)
  const setAccent = useStore((s) => s.setAccent)
  const mediaStorageMode = useStore((s) => s.mediaStorageMode)
  const setMediaStorageMode = useStore((s) => s.setMediaStorageMode)
  const videoCacheQuality = useStore((s) => s.videoCacheQuality)
  const setVideoCacheQuality = useStore((s) => s.setVideoCacheQuality)
  const cacheLimitGb = useStore((s) => s.cacheLimitGb)
  const setCacheLimitGb = useStore((s) => s.setCacheLimitGb)
  const contentSources = useStore((s) => s.contentSources)
  const setContentSources = useStore((s) => s.setContentSources)
  const [index, setIndex] = useState(0)
  const [libraryInfo, setLibraryInfo] = useState<LibraryInfo | null>(null)
  const [choosingFolder, setChoosingFolder] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)

  useEffect(() => {
    void magpie.getLibraryInfo().then(setLibraryInfo).catch(() => {})
  }, [])

  const chooseFolder = async (): Promise<void> => {
    setChoosingFolder(true)
    setFolderError(null)
    try {
      const result = await magpie.chooseLibraryFolder()
      if (!result.moved) setLibraryInfo((info) => (info ? { ...info, dataPath: result.path } : info))
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : String(error))
    } finally {
      setChoosingFolder(false)
    }
  }

  const connectedCount = accounts.filter((a) => a.connected).length

  const features: { key: string; icon: React.JSX.Element; title: TranslationKey; text: TranslationKey }[][] = [
    [
      { key: 'gather', icon: <IconSync size={18} />, title: 'welcome.gatherTitle', text: 'welcome.gatherText' },
      { key: 'see', icon: <IconGrid size={18} />, title: 'welcome.seeTitle', text: 'welcome.seeText' },
      { key: 'organise', icon: <IconTag size={18} />, title: 'welcome.organiseTitle', text: 'welcome.organiseText' },
      { key: 'find', icon: <IconSearch size={18} />, title: 'welcome.findTitle', text: 'welcome.findText' }
    ],
    [
      { key: 'login', icon: <IconCheck size={18} />, title: 'welcome.loginTitle', text: 'welcome.loginText' },
      { key: 'local', icon: <IconStar size={18} />, title: 'welcome.localTitle', text: 'welcome.localText' },
      { key: 'careful', icon: <IconCollections size={18} />, title: 'welcome.carefulTitle', text: 'welcome.carefulText' },
      { key: 'next', icon: <IconSend size={18} />, title: 'welcome.nextTitle', text: 'welcome.nextText' }
    ]
  ]

  const steps = ['hello', 'what', 'storage', 'how', 'connect']
  const isLast = index === steps.length - 1

  return (
    <div className="welcome">
      <div className="welcome__drag" />

      <div className="welcome__panel">
        <div key={steps[index]} className="welcome__step">
          {index === 0 ? (
            <div className="welcome__hero">
              <Logo size={72} />
              <h1>{t('app.name')}</h1>
              <p className="welcome__lead">{t('welcome.tagline')}</p>

              <div className="welcome__prefs">
                <div className="segmented">
                  {LANGUAGES.map((code) => (
                    <button
                      key={code}
                      type="button"
                      className={language === code ? 'is-active' : ''}
                      onClick={() => void setLanguage(code)}
                    >
                      {LANGUAGE_LABEL[code]}
                    </button>
                  ))}
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
              </div>
            </div>
          ) : null}

          {index === 1 || index === 3 ? (
            <>
              <h2>{t(index === 1 ? 'welcome.whatTitle' : 'welcome.howTitle')}</h2>
              <div className="features">
                {features[index === 1 ? 0 : 1].map((f) => (
                  <Feature key={f.key} icon={f.icon} title={t(f.title)} text={t(f.text)} />
                ))}
              </div>
            </>
          ) : null}

          {index === 2 ? (
            <>
              <div className="welcome__storage-head">
                <span className="feature__icon"><IconInbox size={20} /></span>
                <div>
                  <h2>{t('welcome.storageTitle')}</h2>
                  <p className="welcome__lead welcome__lead--tight">{t('welcome.storageText')}</p>
                </div>
              </div>

              <div className="welcome__source-choice">
                <strong>{t('welcome.sourcesTitle')}</strong>
                <span>{t('welcome.sourcesText')}</span>
                <div className="segmented segmented--wide">
                  <button
                    type="button"
                    className={contentSources.length === 1 && contentSources[0] === 'saved' ? 'is-active' : ''}
                    onClick={() => void setContentSources(['saved'])}
                  >
                    {t('source.savedOnly')}
                  </button>
                  <button
                    type="button"
                    className={contentSources.length === 1 && contentSources[0] === 'liked' ? 'is-active' : ''}
                    onClick={() => void setContentSources(['liked'])}
                  >
                    {t('source.likedOnly')}
                  </button>
                  <button
                    type="button"
                    className={contentSources.length === 2 ? 'is-active' : ''}
                    onClick={() => void setContentSources(['saved', 'liked'])}
                  >
                    {t('source.both')}
                  </button>
                </div>
              </div>

              <div className="welcome__storage-options">
                <button
                  type="button"
                  className={`welcome__storage-option ${mediaStorageMode === 'stream' ? 'is-active' : ''}`}
                  onClick={() => void setMediaStorageMode('stream')}
                >
                  <span className="welcome__storage-check"><IconCheck size={14} /></span>
                  <strong>{t('welcome.storageStream')}</strong>
                  <span>{t('welcome.storageStreamText')}</span>
                  <em>{t('welcome.recommended')}</em>
                </button>
                <button
                  type="button"
                  className={`welcome__storage-option ${mediaStorageMode === 'offline' ? 'is-active' : ''}`}
                  onClick={() => void setMediaStorageMode('offline')}
                >
                  <span className="welcome__storage-check"><IconCheck size={14} /></span>
                  <strong>{t('welcome.storageOffline')}</strong>
                  <span>{t('welcome.storageOfflineText')}</span>
                </button>
              </div>

              {mediaStorageMode === 'offline' ? (
                <div className="welcome__storage-row">
                  <span>{t('settings.cacheQuality')}</span>
                  <div className="segmented">
                    {(['480p', '720p', '1080p', 'source'] as VideoQuality[]).map((quality) => (
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
              ) : null}

              <div className="welcome__storage-row welcome__storage-row--path">
                <div>
                  <strong>{t('welcome.storageLocation')}</strong>
                  <span title={libraryInfo?.dataPath}>{libraryInfo?.dataPath ?? t('welcome.storageLoading')}</span>
                </div>
                <button type="button" className="btn" disabled={choosingFolder} onClick={() => void chooseFolder()}>
                  {choosingFolder ? t('settings.choosingLibrary') : t('welcome.storageChoose')}
                </button>
              </div>
              {folderError ? <p className="welcome__storage-error">{folderError}</p> : null}

              <label className="welcome__storage-limit">
                <span>{t('welcome.storageLimit', { size: cacheLimitGb })}</span>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={cacheLimitGb}
                  onChange={(event) => void setCacheLimitGb(Number(event.target.value))}
                />
              </label>
            </>
          ) : null}

          {index === 4 ? (
            <>
              <h2>{t('welcome.connectTitle')}</h2>
              <p className="welcome__lead welcome__lead--tight">{t('welcome.connectText')}</p>
              <Accounts emphasise />
            </>
          ) : null}
        </div>

        <footer className="welcome__foot">
          <button
            type="button"
            className="icon-btn-ghost"
            onClick={() => setIndex((i) => i - 1)}
            disabled={index === 0}
            title={t('welcome.previous')}
          >
            <IconChevronLeft />
          </button>

          <div className="welcome__dots">
            {steps.map((step, i) => (
              <button
                key={step}
                type="button"
                className={`welcome__dot ${i === index ? 'is-active' : ''}`}
                onClick={() => setIndex(i)}
                aria-label={t('welcome.step', { n: i + 1 })}
              />
            ))}
          </div>

          {isLast ? (
            /* Une fois un compte connecté, terminer devient l'action principale ; tant
               qu'il n'y en a pas, c'est « Connecter » qui doit ressortir, pas la sortie. */
            <button
              type="button"
              className={`btn ${connectedCount > 0 ? 'btn--primary' : ''}`}
              onClick={() => void finishOnboarding()}
            >
              {connectedCount > 0 ? t('welcome.finish') : t('welcome.later')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setIndex((i) => i + 1)}
            >
              {t('welcome.continue')}
            </button>
          )}
        </footer>
      </div>

      {!isLast ? (
        <button type="button" className="welcome__skip" onClick={() => void finishOnboarding()}>
          {t('welcome.skip')}
        </button>
      ) : null}
    </div>
  )
}
