import type {
  AnalysisMode,
  CefrEstimate,
  ConfidenceLevel,
  ContentGenre,
  DifficultyAnalysisResult,
  DifficultyBand,
  SegmentAnalysisOut,
} from './types.ts'
import { detectGenre } from './genre-detection.ts'
import {
  type LiterarySignalsBlock,
  computeLiterarySignals,
  learnerComprehensionFromSurfaceAndLiterary,
} from './literary-metrics.ts'
import { LEGAL_ACADEMIC_LEMMAS } from './pt-markers.ts'
import type { TextFeatureBlock } from './text-metrics.ts'
import type { SubtitleFeatureBlock } from './subtitle-metrics.ts'
import type { SegmentMetrics } from './subtitle-metrics.ts'
import { lemmas, stripNoise, wordsFromText } from './tokenize.ts'

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

/** Map subscores 0..1 to contribution to difficulty 0..100 */
function lexicalSubscore(t: TextFeatureBlock): number {
  const a = clamp((t.rareWordRatio - 0.02) / 0.35, 0, 1) * 28
  const b = clamp((t.longWordRatio - 0.05) / 0.35, 0, 1) * 22
  const c = clamp((t.typeTokenRatio - 0.35) / 0.45, 0, 1) * 18
  const d = clamp(t.hapaxRatio - 0.2, 0, 0.6) * 35
  const e = (1 - t.averageWordFrequencyScore) * 22
  return clamp((a + b + c + d + e) / 1.25, 0, 100)
}

function syntacticSubscore(t: TextFeatureBlock): number {
  const a = clamp(t.estimatedClauseDensity, 0, 1.2) * 35
  const b = clamp(t.commaPerSentence / 4, 0, 1) * 18
  const c = clamp(t.subordinateMarkerRatio * 80, 0, 1) * 22
  const d = clamp(t.passiveVoiceMarkerRatio * 40, 0, 1) * 15
  const e = clamp(t.questionRatio * 2, 0, 1) * 5
  return clamp(a + b + c + d + e, 0, 100)
}

function structuralSubscore(t: TextFeatureBlock): number {
  const a = clamp((t.avgSentenceLengthWords - 8) / 22, 0, 1) * 38
  const b = clamp((t.avgWordLength - 4.2) / 3.5, 0, 1) * 22
  const c = clamp((t.charCount - 400) / 8000, 0, 1) * 15
  return clamp(a + b + c, 0, 100)
}

function subtitleSubscore(s: SubtitleFeatureBlock): number {
  const cps = s.readingSpeedCps
  const a = clamp((cps - 12) / 18, 0, 1) * 42
  const b = clamp(s.subtitleBurstiness, 0, 1.5) * 22
  const c = clamp((s.maxSegmentChars - 42) / 80, 0, 1) * 18
  const d = (1 - clamp(s.timingCoverageRatio, 0.3, 1)) * 12
  return clamp(a + b + c + d, 0, 100)
}

/** Lexical diversity emphasis (TTR / hapax) for literary calibration. */
function lexicalDiversityFocused(t: TextFeatureBlock): number {
  const a = clamp((t.correctedTtr - 0.36) / 0.44, 0, 1) * 44
  const b = clamp((t.typeTokenRatio - 0.3) / 0.5, 0, 1) * 33
  const c = clamp(t.hapaxRatio / 0.55, 0, 1) * 23
  return clamp(a + b + c, 0, 100)
}

function discourseCohesionDifficulty100(lit: LiterarySignalsBlock): number {
  return clamp(lit.lowExplicitCohesionSignal * 100, 0, 100)
}

function pronounAnaphoraDifficulty100(lit: LiterarySignalsBlock): number {
  return clamp((lit.pronounAnaphoraDensityLiterary - 0.09) / 0.24, 0, 1) * 100
}

function contextualDifficulty100(lit: LiterarySignalsBlock, t: TextFeatureBlock): number {
  const nar = clamp(lit.narrativeLiteraryMarkerRatio * 52, 0, 48)
  const rare = clamp((t.rareWordRatio - 0.04) / 0.3, 0, 1) * 52
  return clamp(nar + rare * 0.52, 0, 100)
}

function legalLexicalIntensity100(lem: string[], wc: number): number {
  let h = 0
  for (const w of lem) {
    if (LEGAL_ACADEMIC_LEMMAS.has(w)) h++
  }
  return clamp((h / Math.max(24, wc)) * 92, 0, 100)
}

/** Literary: lower weight on raw L/S/St; higher on diversity, cohesion proxies, pronoun load, context. */
function surfaceLiteraryCalibrated(
  t: TextFeatureBlock,
  lit: LiterarySignalsBlock,
  L: number,
  S: number,
  St: number,
): number {
  const div = lexicalDiversityFocused(t)
  const dcoh = discourseCohesionDifficulty100(lit)
  const pron = pronounAnaphoraDifficulty100(lit)
  const ctx = contextualDifficulty100(lit, t)
  return clamp(
    0.1 * L + 0.08 * S + 0.06 * St + 0.3 * div + 0.2 * dcoh + 0.14 * pron + 0.1 * ctx,
    0,
    100,
  )
}

function surfaceLegalAcademicCalibrated(t: TextFeatureBlock, L: number, S: number, St: number, lem: string[]): number {
  const leg = legalLexicalIntensity100(lem, t.wordCount)
  const pas = clamp(t.passiveVoiceMarkerRatio * 100, 0, 100)
  return clamp(0.26 * L + 0.24 * S + 0.2 * St + 0.18 * leg + 0.12 * pas, 0, 100)
}

function surfaceInformativeBaseline(L: number, S: number, St: number): number {
  return clamp(0.4 * L + 0.35 * S + 0.25 * St, 0, 100)
}

function surfaceLearnerMaterialBaseline(L: number, S: number, St: number): number {
  return clamp(0.42 * L + 0.33 * S + 0.25 * St, 0, 100)
}

function blendTextSurfaceScore(
  p: Record<ContentGenre, number>,
  t: TextFeatureBlock,
  lit: LiterarySignalsBlock,
  L: number,
  S: number,
  St: number,
  lem: string[],
): number {
  const sInf = surfaceInformativeBaseline(L, S, St)
  const sLit = surfaceLiteraryCalibrated(t, lit, L, S, St)
  const sLeg = surfaceLegalAcademicCalibrated(t, L, S, St, lem)
  const sLrn = surfaceLearnerMaterialBaseline(L, S, St)
  return clamp(
    p.informative * sInf + p.literary * sLit + p.legal_academic * sLeg + p.learner_material * sLrn,
    0,
    100,
  )
}

function blendedTextContributions(
  p: Record<ContentGenre, number>,
  t: TextFeatureBlock,
  lit: LiterarySignalsBlock,
  L: number,
  S: number,
  St: number,
  lem: string[],
): {
  lexical: number
  syntactic: number
  structural: number
  vocabularyDifficulty: number
  sentenceComplexity: number
  structureLoad: number
} {
  const div = lexicalDiversityFocused(t)
  const dcoh = discourseCohesionDifficulty100(lit)
  const pron = pronounAnaphoraDifficulty100(lit)
  const ctx = contextualDifficulty100(lit, t)
  const leg = legalLexicalIntensity100(lem, t.wordCount)
  const pas = clamp(t.passiveVoiceMarkerRatio * 100, 0, 100)

  const vocabLine =
    p.informative * (0.4 * L) +
    p.literary * (0.1 * L + 0.3 * div + 0.055 * ctx) +
    p.legal_academic * (0.26 * L + 0.18 * leg) +
    p.learner_material * (0.42 * L)

  const synLine =
    p.informative * (0.35 * S) +
    p.literary * (0.08 * S + 0.14 * pron + 0.045 * ctx) +
    p.legal_academic * (0.24 * S) +
    p.learner_material * (0.33 * S)

  const structLine =
    p.informative * (0.25 * St) +
    p.literary * (0.06 * St + 0.2 * dcoh) +
    p.legal_academic * (0.2 * St + 0.12 * pas) +
    p.learner_material * (0.25 * St)

  return {
    lexical: round4(vocabLine / 100),
    syntactic: round4(synLine / 100),
    structural: round4(structLine / 100),
    vocabularyDifficulty: round4(vocabLine / 100),
    sentenceComplexity: round4(synLine / 100),
    structureLoad: round4(structLine / 100),
  }
}

export function bandFromScore(score: number): DifficultyBand {
  if (score <= 24) return 'very_easy'
  if (score <= 44) return 'easy'
  if (score <= 64) return 'intermediate'
  if (score <= 79) return 'upper_intermediate'
  return 'advanced'
}

export function cefrFromScore(score: number): CefrEstimate {
  if (score <= 19) return 'A1'
  if (score <= 39) return 'A2'
  if (score <= 59) return 'B1'
  if (score <= 74) return 'B2'
  return 'C1'
}

export function confidenceFromFlags(flags: {
  wordCount: number
  sentenceCount: number
  segmentCount: number
  mode: AnalysisMode
  noisySubtitle: boolean
  nonPt: number
}): ConfidenceLevel {
  if (flags.nonPt > 0.12) return 'low'
  if (flags.mode === 'text') {
    if (flags.wordCount < 40 || flags.sentenceCount < 3) return 'low'
    if (flags.wordCount < 120) return 'medium'
    return 'high'
  }
  if (flags.segmentCount < 5 || flags.noisySubtitle) return 'low'
  if (flags.segmentCount < 15) return 'medium'
  return 'high'
}

function buildReasons(
  mode: AnalysisMode,
  t: TextFeatureBlock,
  s: SubtitleFeatureBlock | null,
  score: number,
  literaryDampedComposite: number,
  probableGenre: ContentGenre,
  genreLiteraryProb: number,
): string[] {
  const reasons: string[] = []
  if (t.rareWordRatio > 0.12) {
    reasons.push('Доля редкой лексики относительно высокая — это повышает сложность чтения.')
  }
  if (t.avgSentenceLengthWords > 18) {
    reasons.push('Предложения в среднем длинные; для начинающих такой текст тяжелее.')
  }
  if (t.avgSentenceLengthWords < 10 && t.wordCount > 80) {
    reasons.push('Короткие предложения и простая структура обычно облегчают восприятие.')
  }
  if (t.lexicalDensity > 0.52) {
    reasons.push('Высокая лексическая плотность: много содержательных слов, меньше «служебных».')
  }
  if (t.lexicalDensity < 0.42 && t.wordCount > 60) {
    reasons.push('Ниже доля содержательных слов — текст может восприниматься проще.')
  }
  if (mode === 'subtitles' && s) {
    if (s.readingSpeedCps > 17) {
      reasons.push('Скорость субтитров по символам высокая; читать в темпе видео сложнее.')
    }
    if (s.subtitleBurstiness > 0.45) {
      reasons.push('Неравномерная скорость субтитров: всплески быстрого текста увеличивают нагрузку.')
    }
    if (s.maxSegmentChars > 72) {
      reasons.push('Встречаются длинные реплики в одной строке субтитров — это труднее для глаза.')
    }
  }
  if (t.estimatedClauseDensity > 0.85) {
    reasons.push('Много признаков подчинения и запятых — синтаксис богаче и сложнее.')
  }
  if (reasons.length < 3 && t.longWordRatio > 0.14) {
    reasons.push('Много длинных слов (≥7 букв), что типично для более сложного уровня.')
  }
  if (reasons.length < 3 && score > 60) {
    reasons.push('Совокупность лексических и синтаксических признаков указывает на повышенную сложность.')
  }
  if (reasons.length < 3 && score < 35) {
    reasons.push('Совокупность признаков указывает на относительно простой материал для чтения.')
  }
  if (literaryDampedComposite > 0.28 && reasons.length < 5) {
    reasons.push(
      'Много диалога, указательных местоимений или неровной длины фраз — типично для художественного текста: именно понимание (связи, кто кому говорит) может быть сложнее, чем «читаемость».',
    )
  }
  if (
    mode === 'text' &&
    (probableGenre === 'literary' || genreLiteraryProb > 0.42) &&
    reasons.length < 5
  ) {
    reasons.push(
      'Жанр ближе к художественному: поверхностная оценка сильнее опирается на разнообразие лексики, связность и указательность, чем на «простые» формулы длины предложений.',
    )
  }
  if (mode === 'text' && probableGenre === 'legal_academic' && reasons.length < 5) {
    reasons.push('Похоже на юридический или академический регистр: учтены формальная лексика и пассивные конструкции.')
  }
  if (mode === 'text' && probableGenre === 'learner_material' && reasons.length < 5) {
    reasons.push('Похоже на учебный материал: базовые формулы читаемости весомее; жаргон упражнений и низкая доля редких слов снижают «литературную» поправку.')
  }
  return reasons.slice(0, 5)
}

function buildWarnings(
  mode: AnalysisMode,
  t: TextFeatureBlock,
  s: SubtitleFeatureBlock | null,
  nonPt: number,
  literaryDampedComposite: number,
): string[] {
  const w: string[] = []
  if (t.wordCount < 40) w.push('Мало слов — оценка менее надёжна; возьмите больший фрагмент.')
  if (mode === 'text' && t.sentenceCount < 3) w.push('Мало предложений; метрики структуры менее стабильны.')
  if (mode === 'subtitles' && s && s.segmentCount < 5) w.push('Мало субтитров; оценка режима видео приблизительная.')
  if (nonPt > 0.08) w.push('Заметна доля символов не португальского текста — результат может быть смещён.')
  if (literaryDampedComposite >= 0.36) {
    w.push(
      'Признаки художественной прозы или живого диалога: смысловая нагрузка для ученика может быть выше, чем показывает базовая оценка читаемости.',
    )
  }
  return w
}

function mergeLiteraryFeatures(
  base: Record<string, number>,
  lit: LiterarySignalsBlock,
  surface: number,
  learner: number,
): void {
  const damped = lit.literaryFictionComposite * lit.learnerComprehensionDamping
  Object.assign(base, {
    dialogueRatio: lit.dialogueRatio,
    lexicalDiversityLiterarySignal: lit.lexicalDiversityLiterarySignal,
    explicitCohesionMarkerPer100Words: lit.explicitCohesionMarkerPer100Words,
    lowExplicitCohesionSignal: lit.lowExplicitCohesionSignal,
    pronounAnaphoraDensityLiterary: lit.pronounAnaphoraDensityLiterary,
    narrativeLiteraryMarkerRatio: lit.narrativeLiteraryMarkerRatio,
    sentenceLengthCv: lit.sentenceLengthCoefficientOfVariation,
    sentenceLengthUnevennessSignal: lit.sentenceLengthUnevennessSignal,
    literaryFictionComposite: lit.literaryFictionComposite,
    literarySignalsDamping: lit.learnerComprehensionDamping,
    literaryFictionCompositeDamped: round4(damped),
    surfaceReadabilityScore: round4(surface),
    learnerComprehensionDifficulty: round4(learner),
    comprehensionLiftPoints: round4(learner - surface),
  })
}

export function assembleResult(params: {
  mode: AnalysisMode
  textFeatures: TextFeatureBlock
  subtitleFeatures: SubtitleFeatureBlock | null
  segmentDetails: SegmentMetrics[]
  /** Raw Portuguese text (book or merged subtitles) for literary / discourse signals. */
  sourcePlainText: string
}): DifficultyAnalysisResult {
  const { mode, textFeatures: t, subtitleFeatures: sub, segmentDetails, sourcePlainText } = params
  const nonPt = t.nonPortugueseRatioEstimate

  const literary = computeLiterarySignals(sourcePlainText, t, mode)
  const dampedComposite = literary.literaryFictionComposite * literary.learnerComprehensionDamping
  const lem = lemmas(wordsFromText(stripNoise(sourcePlainText)))
  const genre = detectGenre(mode, t, literary, lem, sourcePlainText)

  const L = lexicalSubscore(t)
  const S = syntacticSubscore(t)
  const St = structuralSubscore(t)
  const U = sub ? subtitleSubscore(sub) : 0

  let final: number
  if (mode === 'text') {
    final = blendTextSurfaceScore(genre.genreScores, t, literary, L, S, St, lem)
  } else {
    final = 0.3 * L + 0.2 * S + 0.15 * St + 0.35 * U
  }
  final = clamp(final, 0, 100)

  const learnerComprehensionDifficulty = learnerComprehensionFromSurfaceAndLiterary(final, literary)
  const learnerBand = bandFromScore(learnerComprehensionDifficulty)
  const learnerCefrEstimate = cefrFromScore(learnerComprehensionDifficulty)

  const noisySubtitle =
    !!sub && (sub.segmentCount > 0 && sub.avgSegmentChars < 12 && sub.readingSpeedCps > 22)

  const conf = confidenceFromFlags({
    wordCount: t.wordCount,
    sentenceCount: t.sentenceCount,
    segmentCount: sub?.segmentCount ?? 0,
    mode,
    noisySubtitle,
    nonPt,
  })

  const reasons = buildReasons(
    mode,
    t,
    sub,
    final,
    dampedComposite,
    genre.probableGenre,
    genre.genreScores.literary,
  )
  const warnings = buildWarnings(mode, t, sub, nonPt, dampedComposite)

  const featuresFlat: Record<string, number> = {
    charCount: t.charCount,
    wordCount: t.wordCount,
    uniqueWordCount: t.uniqueWordCount,
    sentenceCount: t.sentenceCount,
    avgWordLength: round4(t.avgWordLength),
    avgSentenceLengthWords: round4(t.avgSentenceLengthWords),
    avgSentenceLengthChars: round4(t.avgSentenceLengthChars),
    typeTokenRatio: round4(t.typeTokenRatio),
    correctedTtr: round4(t.correctedTtr),
    lexicalDensity: round4(t.lexicalDensity),
    rareWordRatio: round4(t.rareWordRatio),
    longWordRatio: round4(t.longWordRatio),
    hapaxRatio: round4(t.hapaxRatio),
    averageWordFrequencyScore: round4(t.averageWordFrequencyScore),
    commaPerSentence: round4(t.commaPerSentence),
    subordinateMarkerRatio: round4(t.subordinateMarkerRatio),
    conjunctionRatio: round4(t.conjunctionRatio),
    pronounRatio: round4(t.pronounRatio),
    prepositionRatio: round4(t.prepositionRatio),
    estimatedClauseDensity: round4(t.estimatedClauseDensity),
    passiveVoiceMarkerRatio: round4(t.passiveVoiceMarkerRatio),
    questionRatio: round4(t.questionRatio),
    negationRatio: round4(t.negationRatio),
    nonPortugueseRatioEstimate: round4(nonPt),
  }

  if (sub) {
    Object.assign(featuresFlat, {
      segmentCount: sub.segmentCount,
      avgSegmentChars: round4(sub.avgSegmentChars),
      avgSegmentWords: round4(sub.avgSegmentWords),
      maxSegmentChars: sub.maxSegmentChars,
      maxSegmentWords: sub.maxSegmentWords,
      oneLineSegmentRatio: round4(sub.oneLineSegmentRatio),
      readingSpeedCps: round4(sub.readingSpeedCps),
      readingSpeedWps: round4(sub.readingSpeedWps),
      subtitleBurstiness: round4(sub.subtitleBurstiness),
      timingCoverageRatio: round4(sub.timingCoverageRatio),
    })
  }

  mergeLiteraryFeatures(featuresFlat, literary, final, learnerComprehensionDifficulty)
  Object.assign(featuresFlat, {
    genreLiterary: round4(genre.genreScores.literary),
    genreLegalAcademic: round4(genre.genreScores.legal_academic),
    genreLearnerMaterial: round4(genre.genreScores.learner_material),
    genreInformative: round4(genre.genreScores.informative),
    genreSubtitle: round4(genre.genreScores.subtitle),
  })

  const wU = mode === 'subtitles' ? 0.35 : 0
  let contribLex: number
  let contribSyn: number
  let contribStr: number
  let vocabDifficulty: number
  let sentenceComplexity: number
  let structureLoad: number

  if (mode === 'text') {
    const bc = blendedTextContributions(genre.genreScores, t, literary, L, S, St, lem)
    vocabDifficulty = bc.vocabularyDifficulty
    sentenceComplexity = bc.sentenceComplexity
    structureLoad = bc.structureLoad
    contribLex = bc.lexical
    contribSyn = bc.syntactic
    contribStr = bc.structural
  } else {
    const wL = 0.3
    const wS = 0.2
    const wSt = 0.15
    vocabDifficulty = round4((wL * L) / 100)
    sentenceComplexity = round4((wS * S) / 100)
    structureLoad = round4((wSt * St) / 100)
    contribLex = round4((wL * L) / 100)
    contribSyn = round4((wS * S) / 100)
    contribStr = round4((wSt * St) / 100)
  }
  const subtitleReadingSpeed = round4((wU * U) / 100)
  const literaryComprehensionLift = round4(
    Math.max(0, learnerComprehensionDifficulty - final) / 100,
  )

  const segmentsOut: SegmentAnalysisOut[] = segmentDetails
    .map((seg) => ({
      segmentIndex: seg.segmentIndex,
      text: seg.text,
      startMs: seg.startMs,
      endMs: seg.endMs,
      score: round4(seg.localScore),
      cps: round4(seg.cps),
      wps: round4(seg.wps),
      features: {
        chars: seg.chars,
        words: seg.words,
        durationSec: round4(seg.durationSec),
      },
    }))
    .sort((a, b) => b.score - a.score)

  return {
    score: round4(final),
    band: bandFromScore(final),
    cefrEstimate: cefrFromScore(final),
    probableGenre: genre.probableGenre,
    learnerComprehensionDifficulty: round4(learnerComprehensionDifficulty),
    learnerBand,
    learnerCefrEstimate,
    confidence: conf,
    reasons,
    warnings,
    features: featuresFlat,
    contributions: {
      lexical: contribLex,
      syntactic: contribSyn,
      structural: contribStr,
      subtitle: round4((wU * U) / 100),
      vocabularyDifficulty: vocabDifficulty,
      sentenceComplexity: sentenceComplexity,
      subtitleReadingSpeed: subtitleReadingSpeed,
      structureLoad: structureLoad,
      literaryComprehensionLift,
    },
    segments: segmentsOut,
  }
}
