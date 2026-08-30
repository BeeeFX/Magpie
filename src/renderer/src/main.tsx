import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { Notices } from './components/Notices'
import { catchStrayRejections } from './notices'
// Police embarquée : aucune requête réseau, donc compatible avec la CSP stricte et
// identique sur toutes les machines, quelles que soient les polices installées.
// Plus Jakarta Sans plutôt qu'une grotesque neutre : ses formes plus rondes et ses
// terminaisons douces vont avec les angles généreux de l'interface.
import '@fontsource-variable/plus-jakarta-sans'
import './styles.css'

catchStrayRejections()

const container = document.getElementById('root')
if (!container) throw new Error('Élément #root introuvable')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      {/* Hors de `App`, qui sort tôt sur la présentation : c'est là que se fait la connexion
          du premier compte, c'est-à-dire le geste le plus susceptible d'échouer. */}
      <Notices />
    </ErrorBoundary>
  </StrictMode>
)
