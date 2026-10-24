/**
 * L'upsert d'un média, isolé pour être vérifiable.
 *
 * Ce n'est pas un souci de rangement : cette instruction décide, à chaque page
 * resynchronisée, si la vignette et le clip déjà en cache survivent. Elle les a tous jetés
 * pendant plusieurs versions, faute de savoir que les CDN resignent leurs liens. Le banc
 * `npm run check:db` la rejoue donc telle quelle sur une base en mémoire, ce qu'il ne
 * pourrait pas faire si elle restait enfermée dans une fonction qui ouvre la bibliothèque.
 */
/**
 * Une vignette en attente d'un lien neuf — pas une vignette en échec.
 *
 * Instagram signe ses liens de CDN pour quelques jours. Passé ce délai, le téléchargement
 * répondait 403, et chaque refus comptait comme une tentative : au bout de trois, la vignette
 * était déclarée impossible, pour toujours. En cache intelligent, les vignettes ne se préparent
 * qu'une fois regardées et les évincées retournent en file — c'est donc précisément l'historique
 * ancien qui finissait en carrés vides, alors que chaque post s'ouvrait parfaitement sur le site.
 *
 * Un lien périmé ne dit rien du média : il ne coûte pas de tentative. Le média sort de la file
 * avec cette valeur, qui dépasse le plafond de trois sans se confondre avec lui, et y revient
 * dès qu'un lien neuf arrive — voir l'upsert ci-dessous et `media/links.ts`. La colonne sert
 * aux deux parce que le schéma n'appartient pas à ce module ; `attachMedia` montre ces
 * vignettes « en préparation », ce qui est exact, et ce qui fait que la grille les redemande.
 */
export const THUMB_AWAITING_LINK = 99

export const MEDIA_UPSERT_SQL = /* sql */ `
  INSERT INTO media (post_id, idx, kind, remote_url, source_path, video_source)
  VALUES (@post_id, @idx, @kind, @remote_url, @source_path, @video_source)
  ON CONFLICT(post_id, idx) DO UPDATE SET
    kind         = excluded.kind,
    /* Ce qui décide de jeter le cache n'est pas l'égalité des URLs mais celle des assets
       qu'elles désignent : les liens signés des CDN changent à chaque requête, et les
       comparer tels quels vidait la bibliothèque de ses vignettes à chaque page
       resynchronisée. Voir media/identity.ts. */
    thumb_path   = CASE
                     WHEN media_identity(media.remote_url)
                       IS media_identity(excluded.remote_url)
                       THEN media.thumb_path
                     ELSE NULL
                   END,
    /* Un lien neuf pour le même fichier rend ses tentatives à une vignette qui n'existe pas
       encore — en échec ou en attente d'un lien. Sans cela, une synchronisation qui rapportait
       un lien valide laissait la vignette déclarée impossible : les tentatives restaient
       attachées au média, alors qu'elles avaient été perdues contre l'ancien lien. */
    thumb_attempts = CASE
                       WHEN media_identity(media.remote_url)
                         IS NOT media_identity(excluded.remote_url)
                         THEN 0
                       WHEN media.thumb_path IS NULL
                         AND media.remote_url IS NOT excluded.remote_url
                         THEN 0
                       ELSE media.thumb_attempts
                     END,
    video_path   = CASE
                     WHEN media_identity(media.video_source)
                       IS media_identity(excluded.video_source)
                       THEN media.video_path
                     ELSE NULL
                   END,
    video_cache_state = CASE
                          WHEN media_identity(media.video_source)
                            IS media_identity(excluded.video_source)
                            THEN media.video_cache_state
                          ELSE 'pending'
                        END,
    video_attempts = CASE
                       WHEN media_identity(media.video_source)
                         IS media_identity(excluded.video_source)
                         THEN media.video_attempts
                       ELSE 0
                     END,
    remote_url   = excluded.remote_url,
    source_path  = excluded.source_path,
    video_source = excluded.video_source
`
