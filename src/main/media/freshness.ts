/**
 * Péremption d'un lien média.
 *
 * Instagram signe ses URLs de CDN et inscrit leur date d'expiration dedans, en secondes
 * Unix hexadécimales sous le paramètre `oe`. Passé ce moment, le CDN répond « URL signature
 * expired » — la page du post, elle, continue de fonctionner puisqu'elle regénère un lien
 * frais à chaque affichage. Lire cette date permet de renouveler *avant* d'essayer, plutôt
 * que d'infliger une erreur à l'utilisateur puis de rattraper.
 */

export function mediaUrlExpiry(url: string): number | null {
  try {
    const value = new URL(url).searchParams.get('oe')
    if (!value || !/^[0-9a-f]+$/i.test(value)) return null
    const seconds = Number.parseInt(value, 16)
    // Une valeur aberrante ne doit pas faire passer un lien valide pour périmé.
    return Number.isFinite(seconds) && seconds > 1_000_000_000 ? seconds * 1000 : null
  } catch {
    return null
  }
}

/**
 * Une marge d'une minute évite de lancer une lecture sur un lien qui expirera pendant
 * qu'elle démarre. Un lien sans date connue est considéré valide : c'est le cas de X, dont
 * les URLs ne portent pas de signature.
 */
export function isMediaUrlExpired(url: string, skewMs = 60_000, now = Date.now()): boolean {
  const expiry = mediaUrlExpiry(url)
  return expiry !== null && expiry - skewMs <= now
}
