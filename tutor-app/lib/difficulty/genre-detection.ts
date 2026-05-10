/**
 * Heuristic genre classification for surface-score calibration (deterministic).
 */
import type { AnalysisMode, ContentGenre } from './types.ts'
import type { TextFeatureBlock } from './text-metrics.ts'
import type { LiterarySignalsBlock } from './literary-metrics.ts'
import { INFORMATIVE_LEMMAS, LEGAL_ACADEMIC_LEMMAS, PEDAGOGICAL_LEMMAS } from './pt-markers.ts'
import { stripNoise } from './tokenize.ts'

const GENRES: ContentGenre[] = [
  'learner_material',
  'subtitle',
  'informative',
  'literary',
  'legal_academic',
]

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function softmax(logits: Record<ContentGenre, number>, temperature: number): Record<ContentGenre, number> {
  const keys = GENRES
  const mx = Math.max(...keys.map((k) => logits[k]))
  const expMap: Partial<Record<ContentGenre, number>> = {}
  let sum = 0
  for (const k of keys) {
    const v = Math.exp((logits[k] - mx) / temperature)
    expMap[k] = v
    sum += v
  }
  const out: Record<ContentGenre, number> = {
    learner_material: 0,
    subtitle: 0,
    informative: 0,
    literary: 0,
    legal_academic: 0,
  }
  for (const k of keys) {
    out[k] = sum > 0 ? (expMap[k] ?? 0) / sum : 1 / keys.length
  }
  return out
}

function argmaxGenre(probs: Record<ContentGenre, number>): ContentGenre {
  const priority: ContentGenre[] = [
    'literary',
    'legal_academic',
    'learner_material',
    'informative',
    'subtitle',
  ]
  let best = priority[0]
  for (const g of priority) {
    if (probs[g] > probs[best] + 1e-10) best = g
  }
  return best
}

function countLemmaHits(lem: string[], set: Set<string>): number {
  let n = 0
  for (const w of lem) {
    if (set.has(w)) n++
  }
  return n
}

export interface GenreDetectionResult {
  probableGenre: ContentGenre
  genreScores: Record<ContentGenre, number>
}

/**
 * Subtitle mode → fixed `subtitle`. Text mode → softmax over literary / legal / learner / informative.
 */
export function detectGenre(
  mode: AnalysisMode,
  t: TextFeatureBlock,
  lit: LiterarySignalsBlock,
  lem: string[],
  rawText: string,
): GenreDetectionResult {
  if (mode === 'subtitles') {
    const genreScores: Record<ContentGenre, number> = {
      subtitle: 1,
      literary: 0,
      informative: 0,
      learner_material: 0,
      legal_academic: 0,
    }
    return { probableGenre: 'subtitle', genreScores }
  }

  const wc = Math.max(1, t.wordCount)
  const text = stripNoise(rawText)

  const litLog =
    2.85 * lit.literaryFictionComposite +
    1.55 * lit.dialogueRatio +
    0.95 * lit.sentenceLengthUnevennessSignal +
    0.55 * lit.lexicalDiversityLiterarySignal -
    0.45

  const legalHits = countLemmaHits(lem, LEGAL_ACADEMIC_LEMMAS)
  const legLog =
    (legalHits / wc) * 48 +
    (t.avgWordLength > 5.85 ? 1.15 : 0) +
    (t.longWordRatio > 0.165 ? 1.35 : 0) +
    (lit.dialogueRatio < 0.07 ? 0.55 : -0.95) +
    clamp(t.passiveVoiceMarkerRatio * 38, 0, 2.2) -
    0.35 * lit.literaryFictionComposite

  const pedHits = countLemmaHits(lem, PEDAGOGICAL_LEMMAS)
  const pedPhrase = /\b(?:complete\s+a|marque\s+a|verdadeiro|falso|gabarito|unidade\s+\d|lição\s+\d)\b/giu.test(text)
    ? 1.1
    : 0
  const learnLog =
    (t.rareWordRatio < 0.062 ? 1.95 : 0) +
    (t.avgSentenceLengthWords < 17.2 ? 0.65 : 0) +
    (lit.explicitCohesionMarkerPer100Words > 2.35 ? 0.85 : 0) +
    pedHits * 0.42 +
    pedPhrase +
    (lit.literaryFictionComposite < 0.2 ? 0.55 : -1.05)

  const infoHits = countLemmaHits(lem, INFORMATIVE_LEMMAS)
  const infLog =
    1.05 +
    (infoHits / wc) * 30 +
    (lit.dialogueRatio < 0.09 && lit.literaryFictionComposite < 0.3 ? 0.75 : 0) -
    (lit.literaryFictionComposite > 0.52 ? 2.35 : 0) -
    (legalHits / wc > 0.045 ? 1.8 : 0)

  const logits: Record<ContentGenre, number> = {
    literary: litLog,
    legal_academic: legLog,
    learner_material: learnLog,
    informative: infLog,
    subtitle: -80,
  }

  const genreScores = softmax(logits, 1.15)
  const probableGenre = argmaxGenre(genreScores)

  return { probableGenre, genreScores }
}
