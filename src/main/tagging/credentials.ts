import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiProvider } from '@shared/types'

type CredentialFile = Partial<Record<AiProvider, string>>

function path(): string {
  return join(app.getPath('userData'), 'ai-credentials.json')
}

function read(): CredentialFile {
  try {
    return existsSync(path()) ? (JSON.parse(readFileSync(path(), 'utf8')) as CredentialFile) : {}
  } catch {
    return {}
  }
}

export function hasAiKey(provider: AiProvider): boolean {
  return Boolean(read()[provider])
}

export function writeAiKey(provider: AiProvider, key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Le coffre sécurisé du système n’est pas disponible sur cet ordinateur.')
  }
  const values = read()
  if (key.trim()) values[provider] = safeStorage.encryptString(key.trim()).toString('base64')
  else delete values[provider]

  const temporary = `${path()}.tmp`
  writeFileSync(temporary, JSON.stringify(values, null, 2))
  renameSync(temporary, path())
}

export function readAiKey(provider: AiProvider): string {
  const encoded = read()[provider]
  if (!encoded) throw new Error('Aucune clé API enregistrée pour ce fournisseur.')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Le coffre sécurisé du système n’est pas disponible.')
  }
  return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
}
