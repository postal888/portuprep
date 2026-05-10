/**
 * Literary / narrative prose heuristics for learner comprehension difficulty
 * (distinct from surface lexical–syntactic readability).
 */
import type { AnalysisMode } from './types.ts'
import type { TextFeatureBlock } from './text-metrics.ts'
import {
  DEMONSTRATIVES_ANAPHORA,
  EXPLICIT_DISCOURSE_MARKERS,
  NARRATIVE_LITERARY_LEMMAS,
  PRONOUNS,
} from './pt-markers.ts'
import { wordRank } from './lexicon.ts'
import { lemmas, splitSentences, stripNoise, wordsFromText } from './tokenize.ts'

/** Portuguese dialogue cues — lines often begin with em dash or quotation marks. */
const DIALOGUE_START_RE = /^[—–]\s*\p{L}/u
const DIALOGUE_QUOTE_START = /^[«„"“'\u201e\u201c]/

const COHESION_PHRASE_RE =
  /\b(?:por\s+isso|desse\s+jeito|deste\s+modo|dessa\s+forma|além\s+disso|em\s+resumo|ou\s+seja|por\s+exemplo|no\s+entanto)\b/giu

/** Exclude o/a/os/as from pronoun–anaphora tally (article vs clitic ambiguity). */
const SKIP_PRONOUN_LEMMA = new Set(['o', 'a', 'os', 'as'])

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

export interface LiterarySignalsBlock {
  dialogueRatio: number
  lexicalDiversityLiterarySignal: number
  explicitCohesionMarkerPer100Words: number
  lowExplicitCohesionSignal: number
  pronounAnaphoraDensityLiterary: number
  narrativeLiteraryMarkerRatio: number
  sentenceLengthCoefficientOfVariation: number
  sentenceLengthUnevennessSignal: number
  literaryFictionComposite: number
  learnerComprehensionDamping: number
}

export function isLikelyDialogueLine(s: string): boolean {
  const x = s.trim()
  if (x.length < 2) return false
  if (DIALOGUE_START_RE.test(x)) return true
  if (DIALOGUE_QUOTE_START.test(x)) return true
  if (
    /\b(?:disse|perguntou|respondeu|replicou|murmurou|sussurrou|exclamou|balbuciou|gritou)\b/i.test(x) &&
    /[—–\-]/.test(x)
  ) {
    return true
  }
  return false
}

/**
 * Combined raw text + surface metrics → literary-fiction likelihood 0..1,
 * then damped for subtitle mode (dialogue-heavy by medium).
 */
export function computeLiterarySignals(
  rawText: string,
  t: TextFeatureBlock,
  mode: AnalysisMode,
): LiterarySignalsBlock {
  const text = stripNoise(rawText)
  const sentences = splitSentences(text)
  const words = wordsFromText(text)
  const lem = lemmas(words)
  const sc = Math.max(1, sentences.length)
  const wc = Math.max(1, words.length)

  let dialogueSents = 0
  for (const s of sentences) {
    if (isLikelyDialogueLine(s)) dialogueSents++
  }
  const dialogueRatio = dialogueSents / sc

  const lexicalDiversityLiterarySignal = clamp((t.correctedTtr - 0.42) / 0.38, 0, 1)

  let cohesionWordHits = 0
  for (const L of lem) {
    if (EXPLICIT_DISCOURSE_MARKERS.has(L)) cohesionWordHits++
  }
  let phraseHits = 0
  const phraseMatches = text.match(COHESION_PHRASE_RE)
  if (phraseMatches) phraseHits += phraseMatches.length
  const cohesionHits = cohesionWordHits + phraseHits * 1.15
  const explicitCohesionMarkerPer100Words = (cohesionHits / wc) * 100
  const lowExplicitCohesionSignal = clamp((2.85 - explicitCohesionMarkerPer100Words) / 2.85, 0, 1)

  let anaHits = 0
  for (const L of lem) {
    if (SKIP_PRONOUN_LEMMA.has(L)) continue
    if (DEMONSTRATIVES_ANAPHORA.has(L) || PRONOUNS.has(L)) anaHits++
  }
  const pronounAnaphoraDensityLiterary = anaHits / wc
  const pronounAnaphoraSignal = clamp((pronounAnaphoraDensityLiterary - 0.11) / 0.22, 0, 1)

  let nar = 0
  for (const L of lem) {
    if (NARRATIVE_LITERARY_LEMMAS.has(L)) {
      nar += 1
      continue
    }
    if (wordRank(L) > 5200) nar += 0.38
  }
  const narrativeLiteraryMarkerRatio = nar / wc
  const narrativeSignal = clamp(narrativeLiteraryMarkerRatio * 19, 0, 1)

  const lens = sentences.map((s) => Math.max(0, wordsFromText(s).length))
  const lensUse = lens.some((n) => n > 0) ? lens.map((n) => Math.max(1, n)) : [1]
  const mean = lensUse.reduce((a, b) => a + b, 0) / lensUse.length
  let varSum = 0
  for (const ln of lensUse) varSum += (ln - mean) ** 2
  const variance = lensUse.length > 1 ? varSum / lensUse.length : 0
  const std = Math.sqrt(variance)
  const sentenceLengthCoefficientOfVariation = mean > 0 ? std / mean : 0
  const sentenceLengthUnevennessSignal = clamp((sentenceLengthCoefficientOfVariation - 0.38) / 0.55, 0, 1)

  const dialogueSignal = clamp(dialogueRatio * 1.22, 0, 1)
  const wd = [0.2, 0.17, 0.17, 0.16, 0.14, 0.16]
  let liter =
    wd[0] * dialogueSignal +
    wd[1] * lexicalDiversityLiterarySignal +
    wd[2] * lowExplicitCohesionSignal +
    wd[3] * pronounAnaphoraSignal +
    wd[4] * narrativeSignal +
    wd[5] * sentenceLengthUnevennessSignal
  liter = clamp(liter, 0, 1)

  const learnerComprehensionDamping = mode === 'subtitles' ? 0.52 : 1

  return {
    dialogueRatio: round4(dialogueRatio),
    lexicalDiversityLiterarySignal: round4(lexicalDiversityLiterarySignal),
    explicitCohesionMarkerPer100Words: round4(explicitCohesionMarkerPer100Words),
    lowExplicitCohesionSignal: round4(lowExplicitCohesionSignal),
    pronounAnaphoraDensityLiterary: round4(pronounAnaphoraDensityLiterary),
    narrativeLiteraryMarkerRatio: round4(narrativeLiteraryMarkerRatio),
    sentenceLengthCoefficientOfVariation: round4(sentenceLengthCoefficientOfVariation),
    sentenceLengthUnevennessSignal: round4(sentenceLengthUnevennessSignal),
    literaryFictionComposite: round4(liter),
    learnerComprehensionDamping,
  }
}

export function learnerComprehensionFromSurfaceAndLiterary(surface: number, lit: LiterarySignalsBlock): number {
  const damp = lit.learnerComprehensionDamping
  const composite = lit.literaryFictionComposite * damp
  const extra = composite * (22 + 0.34 * Math.max(0, 100 - surface))
  return clamp(surface + extra, 0, 100)
}
