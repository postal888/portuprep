import {
  CONJUNCTIONS,
  FUNCTION_WORDS,
  NEGATION_MARKERS,
  PREPOSITIONS,
  PRONOUNS,
  SUBORDINATE_MARKERS,
} from './pt-markers.ts'
import { wordRank } from './lexicon.ts'
import { lemmas, splitSentences, stripNoise, wordsFromText } from './tokenize.ts'

const LONG_WORD = 7

export interface TextFeatureBlock {
  charCount: number
  wordCount: number
  uniqueWordCount: number
  sentenceCount: number
  avgWordLength: number
  avgSentenceLengthWords: number
  avgSentenceLengthChars: number
  typeTokenRatio: number
  correctedTtr: number
  lexicalDensity: number
  rareWordRatio: number
  longWordRatio: number
  hapaxRatio: number
  averageWordFrequencyScore: number
  commaPerSentence: number
  subordinateMarkerRatio: number
  conjunctionRatio: number
  pronounRatio: number
  prepositionRatio: number
  estimatedClauseDensity: number
  passiveVoiceMarkerRatio: number
  questionRatio: number
  negationRatio: number
  nonPortugueseRatioEstimate: number
}

/** Moving-window TTR approximation (first 3 windows). */
function movingTtrApprox(words: string[], window: number): number {
  if (words.length === 0) return 0
  const wins: number[] = []
  for (let i = 0; i < words.length; i += window) {
    const slice = words.slice(i, i + window)
    const uniq = new Set(lemmas(slice)).size
    wins.push(slice.length ? uniq / slice.length : 0)
  }
  return wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
}

/** Heuristic: Cyrillic or non-Latin letters ratio. */
function nonPtRatio(words: string[]): number {
  if (!words.length) return 0
  let bad = 0
  for (const w of words) {
    if (/[\u0400-\u04FF]/.test(w)) bad++
    else if (/[\u0600-\u06FF]/.test(w)) bad++
  }
  return bad / words.length
}

/** Very rough passive proxy: "foi Xado/ada" or "é Xado" patterns in window. */
function passiveProxyScore(sentences: string[]): number {
  let hits = 0
  let words = 0
  const rePassive = /\b(?:foi|foi|são|será|era|eram|é|são)\s+[\p{L}\p{M}]{3,}(?:ado|ada|ados|idas|idos)/giu
  for (const s of sentences) {
    const w = wordsFromText(s)
    words += w.length
    const m = s.match(rePassive)
    if (m) hits += m.length
  }
  return words ? hits / words : 0
}

export function computeTextMetrics(rawText: string): TextFeatureBlock {
  const text = stripNoise(rawText)
  const sentences = splitSentences(text)
  const words = wordsFromText(text)
  const lem = lemmas(words)
  const charCount = text.length
  const wordCount = words.length
  const unique = new Set(lem)
  const uniqueWordCount = unique.size
  const sentenceCount = Math.max(1, sentences.length)

  const avgWordLength = wordCount ? words.reduce((a, w) => a + w.length, 0) / wordCount : 0
  const avgSentenceLengthWords = wordCount / sentenceCount
  const avgSentenceLengthChars = charCount / sentenceCount

  const ttr = wordCount ? uniqueWordCount / wordCount : 0
  const correctedTtr = movingTtrApprox(words, 50)

  let functionHits = 0
  let rare = 0
  let longw = 0
  let freqScoreSum = 0
  const counts = new Map<string, number>()
  for (const L of lem) {
    counts.set(L, (counts.get(L) ?? 0) + 1)
    if (FUNCTION_WORDS.has(L)) functionHits++
    const r = wordRank(L)
    if (r > 3500) rare++
    const wlen = L.length
    if (wlen >= LONG_WORD) longw++
    const maxR = 8000
    freqScoreSum += 1 - Math.min(Math.log(r + 1), Math.log(maxR + 1)) / Math.log(maxR + 1)
  }
  const lexicalDensity = wordCount ? 1 - functionHits / wordCount : 0
  const rareWordRatio = wordCount ? rare / wordCount : 0
  const longWordRatio = wordCount ? longw / wordCount : 0
  const hapax = [...counts.values()].filter((c) => c === 1).length
  const hapaxRatio = uniqueWordCount ? hapax / uniqueWordCount : 0
  const averageWordFrequencyScore = wordCount ? freqScoreSum / wordCount : 0

  let commas = 0
  let subM = 0
  let conj = 0
  let pro = 0
  let prep = 0
  let neg = 0
  let questions = 0
  for (const L of lem) {
    if (SUBORDINATE_MARKERS.has(L)) subM++
    if (CONJUNCTIONS.has(L)) conj++
    if (PRONOUNS.has(L)) pro++
    if (PREPOSITIONS.has(L)) prep++
    if (NEGATION_MARKERS.has(L)) neg++
  }
  for (const s of sentences) {
    commas += (s.match(/,/g) || []).length
    if (/\?/.test(s)) questions++
  }

  const commaPerSentence = commas / sentenceCount
  const subordinateMarkerRatio = wordCount ? subM / wordCount : 0
  const conjunctionRatio = wordCount ? conj / wordCount : 0
  const pronounRatio = wordCount ? pro / wordCount : 0
  const prepositionRatio = wordCount ? prep / wordCount : 0
  const estimatedClauseDensity = commaPerSentence * 0.4 + subordinateMarkerRatio * 2.5
  const passiveVoiceMarkerRatio = passiveProxyScore(sentences)
  const questionRatio = questions / sentenceCount
  const negationRatio = wordCount ? neg / wordCount : 0
  const nonPortugueseRatioEstimate = nonPtRatio(words)

  return {
    charCount,
    wordCount,
    uniqueWordCount,
    sentenceCount,
    avgWordLength,
    avgSentenceLengthWords,
    avgSentenceLengthChars,
    typeTokenRatio: ttr,
    correctedTtr,
    lexicalDensity,
    rareWordRatio,
    longWordRatio,
    hapaxRatio,
    averageWordFrequencyScore,
    commaPerSentence,
    subordinateMarkerRatio,
    conjunctionRatio,
    pronounRatio,
    prepositionRatio,
    estimatedClauseDensity,
    passiveVoiceMarkerRatio,
    questionRatio,
    negationRatio,
    nonPortugueseRatioEstimate,
  }
}
