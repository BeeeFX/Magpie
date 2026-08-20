/**
 * Identité stable d'une URL média.
 *
 * Instagram et X resignent leurs liens à chaque requête : pour un fichier rigoureusement
 * identique, l'hôte (`scontent-lhr6-2` puis `scontent-lhr11-1`), le jeton (`_nc_ohc`), la
 * signature (`oh`) et l'expiration (`oe`) changent d'une synchronisation à l'autre.
 * Comparer les URLs entières revenait donc à conclure « ce média a changé » sur chaque page
 * resynchronisée — et à jeter la vignette et le clip déjà en cache. Une bibliothèque entière
 * repassait ainsi en « média en préparation » pendant que ses fichiers dormaient, orphelins,
 * dans le dossier du cache.
 *
 * On ne compare donc que ce qui désigne l'asset :
 *
 * - les photos le portent dans leur chemin
 *   (`/v/t51.82787-15/760930005_18548507644073237_…_n.webp`) ;
 * - les clips Instagram ont un chemin jetable (`/o1/v/t2/f2/m86/AQPO….mp4`) mais
 *   transportent l'asset permanent dans `_nc_vs`, et son identifiant numérique dans le JSON
 *   base64 de `efg` ;
 * - X n'a besoin de rien d'autre que son chemin.
 *
 * En dernier recours on retourne le chemin : au pire il bouge autant que l'URL entière, et
 * on ne fait alors pas moins bien qu'avant.
 */

/** `efg` porte le tag d'encodage de tout le monde, mais l'identifiant d'asset des seuls clips. */
function assetIdFromEfg(value: string): string | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >
    const id = decoded['xpv_asset_id']
    return typeof id === 'number' || typeof id === 'string' ? `xpv:${id}` : null
  } catch {
    // Un `efg` illisible n'apprend rien ; le chemin prendra le relais.
    return null
  }
}

export function mediaIdentity(url: string | null | undefined): string | null {
  if (!url) return null
  // Un fichier local est déjà sa propre identité.
  if (!/^https?:/i.test(url)) return url

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  const permanent = parsed.searchParams.get('_nc_vs')
  if (permanent) return `nc_vs:${permanent}`

  const efg = parsed.searchParams.get('efg')
  if (efg) {
    const asset = assetIdFromEfg(efg)
    if (asset) return asset
  }

  return parsed.pathname
}
