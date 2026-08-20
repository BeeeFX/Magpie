/**
 * Ce que le dessin de la carte coûte réellement, image par image.
 *
 * Trois tentatives d'optimisation ont visé à côté faute de mesure : la résolution du calque, le
 * découpage en tranches, la coalescence des dessins. Chacune reposait sur un raisonnement juste
 * et sur une hypothèse fausse quant à *où* passait le temps. Un compteur coûte quelques dizaines
 * de lignes et remplace le raisonnement par un chiffre.
 *
 * Le relevé vit hors de React, dans un singleton : il est écrit depuis la boucle de dessin, à
 * chaque image, et lu par un écran qui ne doit surtout pas provoquer de rendu en le lisant.
 */

/** Combien d'images on garde. Deux secondes à soixante images : assez pour un centile. */
const WINDOW = 120

interface Frame {
  at: number
  total: number
  parts: Record<string, number>
  notes: Record<string, number | string>
}

const frames: Frame[] = []
let open: Frame | null = null
let spanName = ''
let spanStart = 0
let enabled = false

export function perfEnabled(): boolean {
  return enabled
}

export function setPerfEnabled(value: boolean): void {
  enabled = value
  if (!value) frames.length = 0
}

/** Ouvre une image. Tout ce qui suit lui est imputé jusqu'au `closeFrame`. */
export function openFrame(): void {
  if (!enabled) return
  open = { at: performance.now(), total: 0, parts: {}, notes: {} }
}

/**
 * Mesure une portion nommée.
 *
 * Volontairement sans imbrication : les portions se suivent, elles ne s'emboîtent pas. Une
 * hiérarchie donnerait de plus jolis rapports et permettrait à un total d'être faux sans qu'on
 * le voie — ici, la somme des portions doit approcher le total, sinon il manque une mesure.
 */
export function begin(name: string): void {
  if (!enabled || !open) return
  spanName = name
  spanStart = performance.now()
}

export function end(): void {
  if (!enabled || !open || !spanName) return
  open.parts[spanName] = (open.parts[spanName] ?? 0) + (performance.now() - spanStart)
  spanName = ''
}

/** Un fait à afficher tel quel : nombre d'arêtes, empan, état du tampon. */
export function note(key: string, value: number | string): void {
  if (!enabled || !open) return
  open.notes[key] = value
}

export function closeFrame(): void {
  if (!enabled || !open) return
  open.total = performance.now() - open.at
  frames.push(open)
  if (frames.length > WINDOW) frames.shift()
  open = null
}

export interface PerfSummary {
  frames: number
  /** Images par seconde, mesurées sur l'intervalle réellement écoulé. */
  fps: number
  average: number
  p95: number
  worst: number
  /** Images au-delà de seize millisecondes : celles qui se voient. */
  late: number
  parts: { name: string; average: number; worst: number }[]
  notes: Record<string, number | string>
}

export function summary(): PerfSummary | null {
  if (frames.length < 2) return null
  const totals = frames.map((frame) => frame.total).sort((a, b) => a - b)
  const span = frames[frames.length - 1].at - frames[0].at
  const names = new Set<string>()
  for (const frame of frames) for (const name of Object.keys(frame.parts)) names.add(name)
  return {
    frames: frames.length,
    fps: span > 0 ? ((frames.length - 1) * 1000) / span : 0,
    average: totals.reduce((sum, value) => sum + value, 0) / totals.length,
    p95: totals[Math.min(totals.length - 1, Math.floor(totals.length * 0.95))],
    worst: totals[totals.length - 1],
    late: totals.filter((value) => value > 16.7).length,
    parts: [...names]
      .map((name) => {
        const values = frames.map((frame) => frame.parts[name] ?? 0)
        return {
          name,
          average: values.reduce((sum, value) => sum + value, 0) / values.length,
          worst: Math.max(...values)
        }
      })
      .sort((left, right) => right.average - left.average),
    notes: frames[frames.length - 1].notes
  }
}

/** Le relevé en texte, pour être collé dans une conversation plutôt que photographié. */
export function report(): string {
  const now = summary()
  if (!now) return 'Aucune mesure.'
  const lines = [
    `images ${now.frames} · ${now.fps.toFixed(1)}/s · moyenne ${now.average.toFixed(1)} ms · ` +
      `p95 ${now.p95.toFixed(1)} ms · pire ${now.worst.toFixed(1)} ms · en retard ${now.late}`,
    ...now.parts.map(
      (part) => `  ${part.name.padEnd(14)} moy ${part.average.toFixed(2)} ms  pire ${part.worst.toFixed(1)} ms`
    ),
    `  ${Object.entries(now.notes)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`
  ]
  return lines.join('\n')
}
