import type {
  AnalyzeSubtitleInput,
  AnalyzeTextInput,
  DifficultyAnalysisResult,
  PtVariant,
} from './types.ts'
import { assembleResult } from './score.ts'
import { computeSubtitleMetrics } from './subtitle-metrics.ts'
import { computeTextMetrics } from './text-metrics.ts'
export function analyzePlainText(input: AnalyzeTextInput): DifficultyAnalysisResult {
  const variant: PtVariant = input.variant ?? 'pt-BR'
  void variant
  const raw = (input.text || '').trim()
  const tf = computeTextMetrics(raw)

  const veryShort = tf.wordCount < 40 ? 1 : 0
  const lowSent = tf.sentenceCount < 3 ? 1 : 0

  const result = assembleResult({
    mode: 'text',
    textFeatures: tf,
    subtitleFeatures: null,
    segmentDetails: [],
    sourcePlainText: raw,
  })

  result.features.veryShortTextFlag = veryShort
  result.features.lowSentenceCountFlag = lowSent
  result.features.noisySubtitleFlag = 0
  return result
}

export function analyzeSubtitles(input: AnalyzeSubtitleInput): DifficultyAnalysisResult {
  const variant: PtVariant = input.variant ?? 'pt-BR'
  void variant
  const segs = Array.isArray(input.segments) ? input.segments : []
  const { sub, perSegment, mergedPlain } = computeSubtitleMetrics(segs, input.videoDurationMs)

  const tf = computeTextMetrics(mergedPlain)

  const noisy =
    sub.segmentCount > 0 && sub.avgSegmentChars < 10 && sub.readingSpeedCps > 24 ? 1 : 0

  const result = assembleResult({
    mode: 'subtitles',
    textFeatures: tf,
    subtitleFeatures: sub,
    segmentDetails: perSegment,
    sourcePlainText: mergedPlain,
  })

  result.features.veryShortTextFlag = tf.wordCount < 40 ? 1 : 0
  result.features.lowSentenceCountFlag = tf.sentenceCount < 3 ? 1 : 0
  result.features.noisySubtitleFlag = noisy

  return result
}

/** Re-export for API layer */
export { bandFromScore, cefrFromScore } from './score.ts'
