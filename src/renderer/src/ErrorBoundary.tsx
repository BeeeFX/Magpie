import { Component, type ErrorInfo, type ReactNode } from 'react'
import { resolveLanguage, translate, type TranslationKey } from './i18n'

/**
 * Le dernier filet du rendu.
 *
 * Il n'y en avait aucun : une exception levée n'importe où dans l'arbre démontait la racine et
 * laissait une fenêtre blanche, sans message, sans journal visible et sans moyen de repartir
 * autrement qu'en fermant l'application. Une carte mal formée suffisait.
 *
 * On ne prétend pas réparer — on dit ce qui s'est passé, on donne de quoi le rapporter, et on
 * propose de recharger. La bibliothèque, elle, est en base : rien n'est perdu.
 *
 * En classe parce que React n'expose ce point d'accroche qu'ainsi ; c'est le seul composant du
 * projet dans ce style, et il n'y a pas d'équivalent en fonction.
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * La langue, lue là où elle est écrite plutôt que là où elle est décidée.
 *
 * Ce composant ne peut ni appeler `useT()` — c'est une classe — ni importer le store : il est
 * le filet posé sous ce qui vient justement de tomber, et le store fait partie de ce qui peut
 * tomber. Le store inscrit la langue résolue sur `<html lang>` à chaque changement ; c'est un
 * état déjà réduit à une chaîne, hors de React, et qui survit à l'effondrement de l'arbre. Et
 * si l'effondrement précède le chargement des réglages, l'attribut est vide : `resolveLanguage`
 * retombe alors sur la langue du système, ce qui est exactement la bonne réponse.
 *
 * Sans cela, un utilisateur en anglais voyait le seul écran capable de lui dire que rien n'est
 * perdu s'afficher en français.
 */
function speak(key: TranslationKey): string {
  return translate(resolveLanguage(document.documentElement.lang), key)
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[magpie] Interface interrompue :', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>{speak('crash.title')}</h1>
        <p>{speak('crash.body')}</p>
        <pre>{error.message}</pre>
        <div className="crash__actions">
          <button type="button" onClick={() => window.location.reload()}>
            {speak('crash.reload')}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(`${error.message}\n\n${error.stack ?? ''}`)
            }}
          >
            {speak('notice.copyDetail')}
          </button>
        </div>
      </div>
    )
  }
}
