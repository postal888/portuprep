/** PortuPrep — explainable text/subtitle difficulty analysis (v1). */

export type DifficultyBand = 'very_easy' | 'easy' | 'intermediate' | 'upper_intermediate' | 'advanced'

export type CefrEstimate = 'A1' | 'A2' | 'B1' | 'B2' | 'C1'

export type ConfidenceLevel = 'low' | 'medium' | 'high'

export type AnalysisMode = 'text' | 'subtitles'

export type PtVariant = 'pt-BR' | 'pt-PT'

/** Heuristic content genre for calibration (not mutually exclusive; `probableGenre` = argmax). */
export type ContentGenre =
  | 'learner_material'
  | 'subtitle'
  | 'informative'
  | 'literary'
  | 'legal_academic'

export interface SubtitleSegmentInput {
  text: string
  startMs: number
  endMs: number
}

export interface SegmentAnalysisOut {
  segmentIndex: number
  text: string
  startMs: number | null
  endMs: number | null
  score: number
  cps: number
  wps: number
  features: Record<string, number>
}

export interface DifficultyAnalysisResult {
  /** Surface readability / lexical–syntactic difficulty (0–100). */
  score: number
  band: DifficultyBand
  cefrEstimate: CefrEstimate
  /** Argmax over softmax genre scores (heuristic). */
  probableGenre: ContentGenre
  /** Learner-oriented comprehension load: fiction/dialogue/anaphora/cohesion signals on top of surface score. */
  learnerComprehensionDifficulty: number
  learnerBand: DifficultyBand
  learnerCefrEstimate: CefrEstimate
  confidence: ConfidenceLevel
  reasons: string[]
  warnings: string[]
  features: Record<string, number>
  contributions: {
    lexical: number
    syntactic: number
    structural: number
    subtitle: number
    vocabularyDifficulty: number
    sentenceComplexity: number
    subtitleReadingSpeed: number
    structureLoad: number
    literaryComprehensionLift: number
  }
  segments: SegmentAnalysisOut[]
}

export interface AnalyzeTextInput {
  text: string
  variant?: PtVariant
  mode?: AnalysisMode
}

export interface AnalyzeSubtitleInput {
  segments: SubtitleSegmentInput[]
  /** Total video duration ms if known (for timing_coverage_ratio) */
  videoDurationMs?: number | null
  variant?: PtVariant
}
