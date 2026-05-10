/**
 * JSON file persistence for difficulty analyses (Vite dev/preview middleware).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DifficultyAnalysisResult } from './types.ts'

const __dir = dirname(fileURLToPath(import.meta.url))
export const defaultDifficultyStorePath = join(__dir, '..', '..', 'data', 'difficulty-analyses.json')

export type SourceType = 'TEXT' | 'VIDEO'

export type StoredDifficultyAnalysis = {
  id: string
  userId: string
  sourceType: SourceType
  sourceId: string
  sourceVersionHash: string | null
  variant: 'pt-BR' | 'pt-PT'
  mode: 'text' | 'subtitles'
  probableGenre?: string
  score: number
  band: string
  cefrEstimate: string
  /** Present in v2 analyses; older rows fall back to surface score in API. */
  learnerComprehensionDifficulty?: number
  learnerBand?: string
  learnerCefrEstimate?: string
  confidence: string
  reasons: string[]
  warnings: string[]
  features: Record<string, number>
  contributions: DifficultyAnalysisResult['contributions']
  segments: DifficultyAnalysisResult['segments']
  createdAt: string
  updatedAt: string
}

export type DifficultyStoreFile = { version: 1; analyses: StoredDifficultyAnalysis[] }

const MAX_ANALYSES = 8000

export function hashContent(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32)
}

export function newAnalysisId(): string {
  return `da_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export function readDifficultyStore(path: string = defaultDifficultyStorePath): DifficultyStoreFile {
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) return { version: 1, analyses: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>
      if (r.version === 1 && Array.isArray(r.analyses)) {
        return { version: 1, analyses: r.analyses as StoredDifficultyAnalysis[] }
      }
    }
  } catch {
    /* ignore */
  }
  return { version: 1, analyses: [] }
}

export function writeDifficultyStore(data: DifficultyStoreFile, path: string = defaultDifficultyStorePath) {
  mkdirSync(dirname(path), { recursive: true })
  let list = data.analyses
  if (list.length > MAX_ANALYSES) {
    list = list.slice(list.length - MAX_ANALYSES)
  }
  writeFileSync(path, JSON.stringify({ version: 1, analyses: list }, null, 2), 'utf8')
}

export function appendAnalysis(
  rec: StoredDifficultyAnalysis,
  path: string = defaultDifficultyStorePath,
): void {
  const store = readDifficultyStore(path)
  store.analyses.push(rec)
  writeDifficultyStore(store, path)
}

export function findLatest(
  sourceType: SourceType,
  sourceId: string,
  path: string = defaultDifficultyStorePath,
): StoredDifficultyAnalysis | null {
  const store = readDifficultyStore(path)
  let best: StoredDifficultyAnalysis | null = null
  let bestT = 0
  for (const a of store.analyses) {
    if (a.sourceType !== sourceType || a.sourceId !== sourceId) continue
    const t = Date.parse(a.updatedAt || a.createdAt)
    if (!Number.isFinite(t)) continue
    if (!best || t > bestT) {
      best = a
      bestT = t
    }
  }
  return best
}

export function historyList(
  sourceType: SourceType | null,
  sourceId: string | null,
  limit: number,
  path: string = defaultDifficultyStorePath,
): StoredDifficultyAnalysis[] {
  const store = readDifficultyStore(path)
  let list = store.analyses.filter((a) => {
    if (sourceType && a.sourceType !== sourceType) return false
    if (sourceId && a.sourceId !== sourceId) return false
    return true
  })
  list = list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return list.slice(0, Math.max(1, Math.min(200, limit)))
}
