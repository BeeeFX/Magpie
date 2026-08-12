import type { BrowserWindow } from 'electron'
import type { Platform } from '@shared/types'
import type { MediaInput, PostInput } from '../db/queries'

/** Ce qu'un adaptateur produit pour une page de résultats. */
export interface NormalizedPage {
  posts: PostInput[]
  media: MediaInput[]
  nextCursor: string | null
  done: boolean
}

/**
 * Interface commune aux trois plateformes.
 *
 * Le modèle est identique partout : l'utilisateur se connecte dans une fenêtre intégrée,
 * puis on appelle les endpoints que le site utilise lui-même, avec sa session. Aucune
 * clé d'API, aucune inscription développeur, aucun mot de passe qui transite par nous.
 */
export interface PlatformAdapter {
  readonly platform: Platform
  isConnected(): Promise<boolean>
  connect(parent?: BrowserWindow): Promise<void>
  disconnect(): Promise<void>
  /** Identifiant lisible du compte connecté, pour l'afficher dans les réglages. */
  resolveHandle(): Promise<string | null>
  /**
   * Une page de signets. `startRank` continue la numérotation d'ordre entre les pages —
   * elle sert de substitut à la date de sauvegarde là où la plateforme ne l'expose pas.
   */
  fetchPage(cursor: string | null, startRank: number): Promise<NormalizedPage>
}
