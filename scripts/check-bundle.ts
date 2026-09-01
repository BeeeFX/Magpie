import { read } from './source'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ce qui est analysé au démarrage reste borné : `npm run check:bundle`
 *
 * **Tout le rendu partait en un seul morceau de 1 113 ko**, analysé à chaque lancement.
 * `React.lazy` n'était utilisé nulle part. La carte à elle seule — `OrganizerMap` fait 136 ko
 * de source, plus ses modules de géométrie — représentait le quart de ce poids, pour un écran
 * qu'on n'ouvre pas à chaque session ; le tour d'accueil ne sert **qu'une fois dans la vie de
 * l'installation** ; l'organisateur seulement quand on le demande.
 *
 * Découper ne rend rien plus rapide une fois chargé. Ça retire du travail au démarrage, qui est
 * le seul moment où l'utilisateur attend sans rien voir.
 *
 * Le plafond n'est pas une cible à atteindre mais une alarme : il ne se déplace pas parce qu'on
 * a dépassé, il se déplace quand on décide que le nouveau poids est justifié. C'est la
 * différence entre un budget et un constat.
 */

/** Le morceau d'entrée, en kilo-octets. Mesuré à 947 après le découpage ; la marge est mince. */
const ENTRY_LIMIT_KB = 1000

/** Ce qui ne doit pas s'y trouver, et pourquoi. */
const DEFERRED: { chunk: string; because: string }[] = [
  { chunk: 'LibraryMap', because: 'la carte ne s’ouvre pas à chaque session' },
  { chunk: 'Welcome', because: 'le tour d’accueil ne sert qu’une fois dans la vie' },
  { chunk: 'AiOrganizer', because: 'l’organisateur ne s’ouvre que sur demande' }
]

let failures = 0
function fail(message: string): void {
  failures += 1
  console.log(`  ✗ ${message}`)
}
function pass(message: string): void {
  console.log(`  ✓ ${message}`)
}

const ASSETS = 'out/renderer/assets'

console.log('Vérification du poids analysé au démarrage\n')

let files: string[]
try {
  files = readdirSync(ASSETS).filter((name) => name.endsWith('.js'))
} catch {
  console.log(`  ✗ ${ASSETS} introuvable — lancez d’abord npm run build`)
  process.exitCode = 1
  files = []
}

if (files.length > 0) {
  console.log('le morceau d’entrée reste sous son plafond')
  {
    const entry = files.find((name) => name.startsWith('index-'))
    if (!entry) {
      fail('aucun morceau d’entrée')
    } else {
      const kb = statSync(join(ASSETS, entry)).size / 1024
      if (kb <= ENTRY_LIMIT_KB) pass(`${kb.toFixed(0)} ko, plafond ${ENTRY_LIMIT_KB}`)
      else fail(`${kb.toFixed(0)} ko, au-dessus du plafond de ${ENTRY_LIMIT_KB}`)
    }
  }

  console.log('\nles écrans qu’on n’ouvre pas au lancement sont différés')
  {
    for (const entry of DEFERRED) {
      const chunk = files.find((name) => name.startsWith(`${entry.chunk}-`))
      if (chunk) {
        const kb = statSync(join(ASSETS, chunk)).size / 1024
        pass(`${entry.chunk} — ${kb.toFixed(0)} ko à part : ${entry.because}`)
      } else {
        fail(`${entry.chunk} n’a pas son propre morceau — ${entry.because}`)
      }
    }

    /* Un `React.lazy` peut exister et ne rien découper si le composant est aussi importé
       statiquement ailleurs : le paquet le replie alors dans l'entrée, sans rien dire. On
       vérifie donc dans la sortie, pas dans la source. */
    const app = read('src/renderer/src/App.tsx')
    for (const entry of DEFERRED) {
      if (new RegExp(`import\\('\\./components/${entry.chunk}'\\)`).test(app)) continue
      fail(`App.tsx n’importe pas ${entry.chunk} paresseusement`)
    }
  }
}

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} manquement(s).`)
process.exitCode = failures === 0 ? 0 : 1
