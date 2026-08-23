import { Component, type ErrorInfo, type ReactNode } from 'react'

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
        <h1>Magpie s’est interrompu</h1>
        <p>
          Votre bibliothèque est intacte : posts, tags, favoris et collections sont en base, rien
          n’a été perdu. Recharger la fenêtre suffit le plus souvent.
        </p>
        <pre>{error.message}</pre>
        <div className="crash__actions">
          <button type="button" onClick={() => window.location.reload()}>
            Recharger
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(`${error.message}\n\n${error.stack ?? ''}`)
            }}
          >
            Copier le détail
          </button>
        </div>
      </div>
    )
  }
}
