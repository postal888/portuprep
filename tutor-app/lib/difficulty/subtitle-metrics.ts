import type { SubtitleSegmentInput } from './types.ts'
import { computeTextMetrics } from './text-metrics.ts'
import { stripNoise } from './tokenize.ts'
import { wordsFromText } from './tokenize.ts'

export interface SubtitleFeatureBlock {
  segmentCount: number
  avgSegmentChars: number
  avgSegmentWords: number
  maxSegmentChars: number
  maxSegmentWords: number
  oneLineSegmentRatio: number
  readingSpeedCps: number
  readingSpeedWps: number
  subtitleBurstiness: number
  timingCoverageRatio: number
}

export interface SegmentMetrics {
  segmentIndex: number
  text: string
  startMs: number
  endMs: number
  durationSec: number
  chars: number
  words: number
  cps: number
  wps: number
  localScore: number
}

function meanStd(arr: number[]): { mean: number; std: number } {
  if (!arr.length) return { mean: 0, std: 0 }
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  const v = arr.reduce((a, x) => a + (x - mean) ** 2, 0) / arr.length
  return { mean, std: Math.sqrt(v) }
}

export function computeSubtitleMetrics(
  segments: SubtitleSegmentInput[],
  videoDurationMs: number | null | undefined,
): { sub: SubtitleFeatureBlock; perSegment: SegmentMetrics[]; mergedPlain: string } {
  const cleaned: SubtitleSegmentInput[] = segments
    .map((s) => ({
      text: stripNoise(s.text).replace(/\s+/g, ' ').trim(),
      startMs: s.startMs,
      endMs: s.endMs,
    }))
    .filter((s) => s.endMs > s.startMs && s.text.length > 0)

  const perSegment: SegmentMetrics[] = []
  let totalChars = 0
  let totalWords = 0
  let maxC = 0
  let maxW = 0
  let oneLine = 0
  const cpsList: number[] = []

  for (let i = 0; i < cleaned.length; i++) {
    const s = cleaned[i]
    const dur = (s.endMs - s.startMs) / 1000
    const text = s.text
    const chars = text.length
    const words = wordsFromText(text).length
    const cps = dur > 0 ? chars / dur : 0
    const wps = dur > 0 ? words / dur : 0
    cpsList.push(cps)
    totalChars += chars
    totalWords += words
    if (chars > maxC) maxC = chars
    if (words > maxW) maxW = words
    if (!/\n/.test(text)) oneLine++

    const tm = computeTextMetrics(text)
    const localLex =
      0.35 * Math.min(1, tm.rareWordRatio * 4) +
      0.25 * Math.min(1, tm.longWordRatio * 5) +
      0.2 * Math.min(1, tm.avgSentenceLengthWords / 25) +
      0.2 * Math.min(1, cps / 25)
    const localScore = Math.min(100, Math.max(0, localLex * 100))

    perSegment.push({
      segmentIndex: i,
      text,
      startMs: s.startMs,
      endMs: s.endMs,
      durationSec: dur,
      chars,
      words,
      cps,
      wps,
      localScore,
    })
  }

  const n = cleaned.length || 1
  const avgSegmentChars = totalChars / n
  const avgSegmentWords = totalWords / n
  const { mean: readingSpeedCps, std: cpsStd } = meanStd(cpsList)
  const readingSpeedWps =
    perSegment.reduce((a, s) => a + s.wps, 0) / (perSegment.length || 1)
  const subtitleBurstiness = readingSpeedCps > 0 ? cpsStd / readingSpeedCps : 0

  const mergedPlain = cleaned.map((s) => s.text).join(' ')
  const span =
    cleaned.length >= 2 ? Math.max(0, cleaned[cleaned.length - 1].endMs - cleaned[0].startMs) : 0
  const timingCoverageRatio =
    videoDurationMs && videoDurationMs > 0 ? Math.min(1, span / videoDurationMs) : 1

  return {
    sub: {
      segmentCount: cleaned.length,
      avgSegmentChars,
      avgSegmentWords,
      maxSegmentChars: maxC,
      maxSegmentWords: maxW,
      oneLineSegmentRatio: cleaned.length ? oneLine / cleaned.length : 0,
      readingSpeedCps,
      readingSpeedWps,
      subtitleBurstiness,
      timingCoverageRatio,
    },
    perSegment,
    mergedPlain,
  }
}
