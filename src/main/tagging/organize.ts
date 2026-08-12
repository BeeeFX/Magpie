import type { AiCollectionPlan, AiCollectionSuggestion, Settings } from '@shared/types'
import { app } from 'electron'
import {
  videoAiCandidateIds,
  videoOrganizationItems,
  type VideoOrganizationItem
} from '../db/queries'
import { readSettings } from '../settings'
import { aiTagger } from './ai'
import { readAiKey } from './credentials'

const BATCH_SIZE = 70

interface ProposedCategory {
  name?: unknown
  description?: unknown
  postIds?: unknown
  groupIds?: unknown
}

function cleanJson(value: string): Record<string, unknown> {
  const clean = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(clean) as Record<string, unknown>
}

async function requestJson(system: string, user: string): Promise<Record<string, unknown>> {
  const settings = readSettings()
  const key = readAiKey(settings.aiProvider)

  if (settings.aiProvider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: settings.aiModel,
        max_tokens: 6000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    })
    if (!response.ok) {
      throw new Error(`Claude HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`)
    }
    const data = (await response.json()) as { content?: { type?: string; text?: string }[] }
    return cleanJson(data.content?.find((part) => part.type === 'text')?.text ?? '')
  }

  if (settings.aiProvider === 'gemini') {
    const model = encodeURIComponent(settings.aiModel)
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.15,
            maxOutputTokens: 6000
          }
        })
      }
    )
    if (!response.ok) {
      throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`)
    }
    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    return cleanJson(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
  }

  const endpoint =
    settings.aiProvider === 'openai'
      ? 'https://api.openai.com/v1/chat/completions'
      : settings.aiProvider === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : settings.aiEndpoint
  if (!endpoint) throw new Error('Endpoint compatible OpenAI manquant')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.aiModel,
      temperature: 0.15,
      max_tokens: 6000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      ...(settings.aiProvider === 'openai' ? { response_format: { type: 'json_object' } } : {})
    })
  })
  if (!response.ok) {
    throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`)
  }
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  return cleanJson(data.choices?.[0]?.message?.content ?? '')
}

function compactItem(item: VideoOrganizationItem): Record<string, unknown> {
  return {
    id: item.id,
    description: item.description?.slice(0, 280) ?? item.text?.slice(0, 280) ?? '',
    tags: item.tags.slice(0, 10)
  }
}

function outputLanguage(settings: Settings): string {
  const french =
    settings.language === 'fr' ||
    (settings.language === 'system' && app.getLocale().toLowerCase().startsWith('fr'))
  return french ? 'French' : 'English'
}

async function proposeBatch(
  items: VideoOrganizationItem[],
  batchIndex: number
): Promise<{ suggestions: AiCollectionSuggestion[]; unassigned: number }> {
  const language = outputLanguage(readSettings())
  const system = `You organise a personal video inspiration library. Group every item into one useful topic category. Categories should be broad, stable and reusable; avoid one-item categories unless truly necessary. A video can belong to at most one category. Return JSON only: {"categories":[{"name":"short name","description":"short scope","postIds":["exact id"]}],"unassignedPostIds":["exact id"]}. Write category names and descriptions in ${language}. Never alter an id.`
  const response = await requestJson(system, JSON.stringify(items.map(compactItem)))
  const known = new Set(items.map((item) => item.id))
  const used = new Set<string>()
  const categories = Array.isArray(response.categories)
    ? (response.categories as ProposedCategory[])
    : []
  const suggestions: AiCollectionSuggestion[] = []

  categories.slice(0, 24).forEach((category, index) => {
    const name = typeof category.name === 'string' ? category.name.trim().slice(0, 80) : ''
    const postIds = Array.isArray(category.postIds)
      ? category.postIds.filter(
          (id): id is string => typeof id === 'string' && known.has(id) && !used.has(id)
        )
      : []
    if (!name || postIds.length === 0) return
    postIds.forEach((id) => used.add(id))
    suggestions.push({
      id: `batch-${batchIndex}-${index}`,
      name,
      description:
        typeof category.description === 'string' ? category.description.trim().slice(0, 180) : '',
      postIds
    })
  })

  return { suggestions, unassigned: Math.max(0, items.length - used.size) }
}

async function consolidate(
  preliminary: AiCollectionSuggestion[]
): Promise<AiCollectionSuggestion[]> {
  if (preliminary.length <= 4) return preliminary
  const language = outputLanguage(readSettings())
  const groups = preliminary.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    videos: group.postIds.length
  }))
  const system = `Consolidate preliminary video categories into a coherent personal collection plan. Merge overlapping or closely related groups when useful, but preserve meaningful distinctions. Return 4 to 16 categories as JSON only: {"categories":[{"name":"short name","description":"short scope","groupIds":["exact preliminary id"]}]}. Each preliminary id can occur at most once. Write names and descriptions in ${language}. Never alter an id.`
  const response = await requestJson(system, JSON.stringify(groups))
  const byId = new Map(preliminary.map((group) => [group.id, group]))
  const used = new Set<string>()
  const categories = Array.isArray(response.categories)
    ? (response.categories as ProposedCategory[])
    : []
  const result: AiCollectionSuggestion[] = []

  categories.slice(0, 20).forEach((category, index) => {
    const name = typeof category.name === 'string' ? category.name.trim().slice(0, 80) : ''
    const groupIds = Array.isArray(category.groupIds)
      ? category.groupIds.filter(
          (id): id is string => typeof id === 'string' && byId.has(id) && !used.has(id)
        )
      : []
    if (!name || groupIds.length === 0) return
    groupIds.forEach((id) => used.add(id))
    result.push({
      id: `category-${index}`,
      name,
      description:
        typeof category.description === 'string' ? category.description.trim().slice(0, 180) : '',
      postIds: [...new Set(groupIds.flatMap((id) => byId.get(id)?.postIds ?? []))]
    })
  })

  // Un groupe oublié par le second passage ne disparaît jamais silencieusement.
  for (const group of preliminary) {
    if (!used.has(group.id)) result.push({ ...group, id: `category-${result.length}` })
  }
  return result
}

let currentProposal: Promise<AiCollectionPlan> | null = null

async function buildVideoCollectionProposal(): Promise<AiCollectionPlan> {
  const settings = readSettings()
  // Échouer immédiatement si le coffre n'est plus disponible : sans ce garde-fou, le
  // tagger essaierait inutilement chaque vidéo avant que l'utilisateur voie l'erreur.
  readAiKey(settings.aiProvider)
  const pending = videoAiCandidateIds()
  if (pending.length > 0) await aiTagger.start(pending)

  const items = videoOrganizationItems()
  if (items.length === 0) return { suggestions: [], analysedVideos: 0, unassignedVideos: 0 }

  const preliminary: AiCollectionSuggestion[] = []
  let unassigned = 0
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    const proposed = await proposeBatch(items.slice(offset, offset + BATCH_SIZE), offset / BATCH_SIZE)
    preliminary.push(...proposed.suggestions)
    unassigned += proposed.unassigned
  }

  return {
    suggestions: await consolidate(preliminary),
    analysedVideos: items.length,
    unassignedVideos: unassigned
  }
}

export function proposeVideoCollections(): Promise<AiCollectionPlan> {
  if (currentProposal) return currentProposal
  currentProposal = buildVideoCollectionProposal().finally(() => {
    currentProposal = null
  })
  return currentProposal
}
