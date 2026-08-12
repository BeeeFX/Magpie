import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiTagProgress, Settings } from '@shared/types'
import { mediaDir } from '../db'
import { aiCandidates, applyAiResult, type AiCandidate } from '../db/queries'
import { readSettings } from '../settings'
import { readAiKey } from './credentials'

interface AiResult {
  description: string
  tags: string[]
}

const SYSTEM = `You organise a personal inspiration library. Return JSON only with:
{"description":"one short factual description","tags":["3 to 8 concise reusable topic tags"]}.
Use broad stable categories plus specific useful topics. Do not invent details.`

function imageData(candidate: AiCandidate): string | null {
  if (!candidate.thumbPath) return null
  const path = join(mediaDir(), candidate.thumbPath)
  return existsSync(path) ? readFileSync(path).toString('base64') : null
}

function prompt(candidate: AiCandidate): string {
  return `Platform: ${candidate.platform}\nAuthor: ${candidate.authorHandle ?? 'unknown'}\nText: ${
    candidate.text?.slice(0, 5000) || '(no text; analyse the image)'
  }`
}

function parseResult(value: string): AiResult {
  const clean = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(clean) as { description?: unknown; tags?: unknown }
  if (typeof parsed.description !== 'string' || !Array.isArray(parsed.tags)) {
    throw new Error('Réponse de tagging invalide')
  }
  return {
    description: parsed.description,
    tags: parsed.tags.filter((tag): tag is string => typeof tag === 'string')
  }
}

async function requestCompatible(
  settings: Settings,
  key: string,
  candidate: AiCandidate,
  image: string | null
): Promise<AiResult> {
  const endpoint =
    settings.aiProvider === 'openai'
      ? 'https://api.openai.com/v1/chat/completions'
      : settings.aiProvider === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : settings.aiEndpoint
  if (!endpoint) throw new Error('Endpoint compatible OpenAI manquant')
  const content: unknown[] = [{ type: 'text', text: prompt(candidate) }]
  if (image && settings.aiProvider !== 'deepseek') {
    content.push({ type: 'image_url', image_url: { url: `data:image/webp;base64,${image}` } })
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.aiModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content }
      ],
      ...(settings.aiProvider === 'openai' ? { response_format: { type: 'json_object' } } : {})
    })
  })
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`)
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  return parseResult(data.choices?.[0]?.message?.content ?? '')
}

async function requestAnthropic(
  settings: Settings,
  key: string,
  candidate: AiCandidate,
  image: string | null
): Promise<AiResult> {
  const content: unknown[] = []
  if (image) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: image }
    })
  }
  content.push({ type: 'text', text: prompt(candidate) })
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.aiModel,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content }]
    })
  })
  if (!response.ok) throw new Error(`Claude HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`)
  const data = (await response.json()) as { content?: { type?: string; text?: string }[] }
  return parseResult(data.content?.find((part) => part.type === 'text')?.text ?? '')
}

async function requestGemini(
  settings: Settings,
  key: string,
  candidate: AiCandidate,
  image: string | null
): Promise<AiResult> {
  const parts: unknown[] = []
  if (image) parts.push({ inline_data: { mime_type: 'image/webp', data: image } })
  parts.push({ text: `${SYSTEM}\n\n${prompt(candidate)}` })
  const model = encodeURIComponent(settings.aiModel)
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    }
  )
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`)
  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  return parseResult(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
}

async function analyse(candidate: AiCandidate): Promise<AiResult> {
  const settings = readSettings()
  const key = readAiKey(settings.aiProvider)
  const image = imageData(candidate)
  if (settings.aiProvider === 'anthropic') return requestAnthropic(settings, key, candidate, image)
  if (settings.aiProvider === 'gemini') return requestGemini(settings, key, candidate, image)
  return requestCompatible(settings, key, candidate, image)
}

type Listener = (progress: AiTagProgress) => void

class AiTagger {
  private currentRun: Promise<AiTagProgress> | null = null
  private listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(postIds?: string[]): Promise<AiTagProgress> {
    if (this.currentRun) return this.currentRun
    this.currentRun = this.run(postIds).finally(() => {
      this.currentRun = null
    })
    return this.currentRun
  }

  private emit(progress: AiTagProgress): void {
    for (const listener of this.listeners) listener(progress)
  }

  private async run(postIds?: string[]): Promise<AiTagProgress> {
    const candidates = aiCandidates(postIds)
    const progress: AiTagProgress = {
      done: 0,
      total: candidates.length,
      tagged: 0,
      failed: 0,
      running: true
    }
    this.emit({ ...progress })
    for (const candidate of candidates) {
      try {
        const result = await analyse(candidate)
        applyAiResult(candidate.id, result.description, result.tags)
        progress.tagged++
      } catch (error) {
        progress.failed++
        console.warn(`[magpie] Tagging IA impossible pour ${candidate.id}:`, error)
      }
      progress.done++
      this.emit({ ...progress })
    }
    progress.running = false
    this.emit({ ...progress })
    return progress
  }
}

export const aiTagger = new AiTagger()
