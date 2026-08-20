import { createHash } from 'node:crypto'

/**
 * Noms des fichiers du cache média.
 *
 * Déterministes à partir du couple (post, index) : rejouer le cache n'accumule pas de
 * fichiers orphelins, et un fichier retrouvé sur le disque se rattache sans ambiguïté à sa
 * ligne en base — c'est ce dont vit la réparation de `sync/repair.ts`.
 *
 * Ils vivent à part du cache lui-même pour que cette réparation, purement documentaire,
 * n'ait pas à charger `sharp` ni `ffmpeg` avec eux.
 */

export function thumbName(postId: string, idx: number): string {
  return `${createHash('sha1').update(`${postId}:${idx}`).digest('hex')}.webp`
}

export function videoName(postId: string, idx: number): string {
  return `${createHash('sha1').update(`${postId}:${idx}:video`).digest('hex')}.mp4`
}

/** Le protocole `magpie://` ne sert que des noms de ces formes — voir main/index.ts. */
export const THUMB_NAME_PATTERN = /^[0-9a-f]{40}\.webp$/
export const VIDEO_NAME_PATTERN = /^[0-9a-f]{40}\.mp4$/
