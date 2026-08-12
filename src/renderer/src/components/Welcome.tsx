import { useState } from 'react'
import { ACCENTS, LANGUAGES } from '@shared/types'
import { LANGUAGE_LABEL, type TranslationKey } from '../i18n'
import { useStore, useT } from '../store'
import { Accounts } from './Accounts'
import { Logo } from './Logo'
import {
  IconChevronLeft,
  IconCheck,
  IconCollections,
  IconGrid,
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
  const [index, setIndex] = useState(0)

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

  const steps = ['hello', 'what', 'how', 'connect']
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

          {index === 1 || index === 2 ? (
            <>
              <h2>{t(index === 1 ? 'welcome.whatTitle' : 'welcome.howTitle')}</h2>
              <div className="features">
                {features[index - 1].map((f) => (
                  <Feature key={f.key} icon={f.icon} title={t(f.title)} text={t(f.text)} />
                ))}
              </div>
            </>
          ) : null}

          {index === 3 ? (
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
