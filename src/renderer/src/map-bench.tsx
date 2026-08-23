import { createRoot } from 'react-dom/client'
import type { OrganizerMap as MapData, OrganizerMapPoint } from '@shared/types'
import { OrganizerMap, type ColourMode } from './components/OrganizerMap'
import './styles.css'
import sandbox from '../../../map-sandbox.json'

/**
 * Banc de mesure de la carte : `npm run preview:web`, puis /map-bench.html.
 *
 * La vraie projection — 9 742 posts, 22 amas, celle de `map-sandbox.json` — dans le vrai
 * composant, hors d'Electron. Sur des points inventés la carte est toujours rapide : les
 * amas sont ronds et clairsemés, et c'est justement la densité réelle qui coûte. C'est ici
 * qu'on a vu les 494 ms par image, et ici qu'on vérifie qu'elles sont tombées.
 *
 * `?colour=source` — ou `platform`, `kind` — pour les autres modes de couleur. Le mode
 * « source » avait sa propre panne, invisible en `group` : les étiquettes fabriquaient un
 * faux point pour se colorer, et lire sa provenance plantait l'écran.
 */
const points: OrganizerMapPoint[] = sandbox.points.map((point, index) => ({
  id: String(index),
  x: point.x,
  y: point.y,
  group: String(point.g),
  thumbUrl: null,
  platform: 'instagram',
  kind: 'image',
  sources: ['saved']
}))

const data: MapData = {
  points,
  plan: {
    suggestions: sandbox.groups.map((group) => ({
      id: String(group.id),
      name: group.name,
      postIds: [],
      reason: '',
      ruleKey: String(group.id),
      confidence: 1
    })),
    routes: [],
    analysedVideos: 0,
    unassignedVideos: 0
  } as unknown as MapData['plan']
}

const asked = new URLSearchParams(location.search).get('colour')
const colourMode: ColourMode = (['group', 'platform', 'kind', 'source', 'collection'] as const).includes(
  asked as ColourMode
)
  ? (asked as ColourMode)
  : 'group'

const included = new Set(sandbox.groups.map((group) => String(group.id)))
const names = new Map(sandbox.groups.map((group) => [String(group.id), group.name]))

createRoot(document.getElementById('root')!).render(
  <OrganizerMap
    data={data}
    colourMode={colourMode}
    includedGroups={included}
    groupNames={names}
    showLabels
    onLasso={() => {}}
    onHover={() => {}}
    onOpen={() => {}}
    detail={null}
  />
)
