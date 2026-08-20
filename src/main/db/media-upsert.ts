/**
 * L'upsert d'un média, isolé pour être vérifiable.
 *
 * Ce n'est pas un souci de rangement : cette instruction décide, à chaque page
 * resynchronisée, si la vignette et le clip déjà en cache survivent. Elle les a tous jetés
 * pendant plusieurs versions, faute de savoir que les CDN resignent leurs liens. Le banc
 * `npm run check:db` la rejoue donc telle quelle sur une base en mémoire, ce qu'il ne
 * pourrait pas faire si elle restait enfermée dans une fonction qui ouvre la bibliothèque.
 */
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
    thumb_attempts = CASE
                       WHEN media_identity(media.remote_url)
                         IS media_identity(excluded.remote_url)
                         THEN media.thumb_attempts
                       ELSE 0
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
