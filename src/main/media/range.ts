export interface ByteRange {
  start: number
  end: number
}

/**
 * Analyse une plage HTTP simple. `undefined` signifie qu'aucune plage n'a été demandée,
 * `null` qu'elle est invalide. Les plages multiples ne sont pas utiles au lecteur HTML et
 * sont volontairement refusées plutôt que servies de manière ambiguë.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | null | undefined {
  if (!header) return undefined
  if (!Number.isSafeInteger(size) || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null

  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}
