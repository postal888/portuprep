import { describe, expect, it } from 'vitest'
import { analyzePlainText, analyzeSubtitles } from './analyze.ts'
import { bandFromScore, cefrFromScore } from './score.ts'

const SAMPLE_PT = `
  O tempo hoje está excelente, mas amanhã pode chover.
  Embora seja difícil, vamos continuar a estudar português todos os dias.
  Porque aprender uma língua nova exige paciência e prática constante.
`.trim()

describe('analyzePlainText', () => {
  it('returns score in 0..100 and stable across runs', () => {
    const a = analyzePlainText({ text: SAMPLE_PT, variant: 'pt-BR' })
    const b = analyzePlainText({ text: SAMPLE_PT, variant: 'pt-BR' })
    expect(a.score).toBeGreaterThanOrEqual(0)
    expect(a.score).toBeLessThanOrEqual(100)
    expect(a.score).toBe(b.score)
    expect(a.band).toBe(bandFromScore(a.score))
    expect(a.cefrEstimate).toBe(cefrFromScore(a.score))
    expect(a.learnerComprehensionDifficulty).toBeGreaterThanOrEqual(0)
    expect(a.learnerComprehensionDifficulty).toBeLessThanOrEqual(100)
    expect(a.learnerBand).toBe(bandFromScore(a.learnerComprehensionDifficulty))
    expect(a.learnerCefrEstimate).toBe(cefrFromScore(a.learnerComprehensionDifficulty))
    expect(a.contributions.literaryComprehensionLift).toBeGreaterThanOrEqual(0)
    expect(['learner_material', 'subtitle', 'informative', 'literary', 'legal_academic']).toContain(
      a.probableGenre,
    )
    expect(a.reasons.length).toBeGreaterThan(0)
    expect(a.features.wordCount).toBeGreaterThan(10)
  })

  it('marks very short samples with low confidence', () => {
    const r = analyzePlainText({ text: 'Olá.', variant: 'pt-BR' })
    expect(r.confidence).toBe('low')
  })

  it('raises learner comprehension vs surface when literary-fiction signals are strong', () => {
    const literary =
      '— Não acredito nisto, murmurou ela.\n' +
      '— Acredite. Este momento, aquele silêncio entre nós, mudou tudo.\n' +
      'Ela olhou para a escuridão; o coração batia forte. Porém não disse nada.\n' +
      '— Porque hesitas? perguntou ele, quase um sussurro.\n' +
      'A nostalgia daquela lembrança recordava outro tempo, outro lugar.'
    const r = analyzePlainText({ text: literary, variant: 'pt-BR' })
    expect(r.features.literaryFictionComposite).toBeGreaterThan(0.12)
    expect(r.learnerComprehensionDifficulty).toBeGreaterThan(r.score)
    if ((r.features.literaryFictionCompositeDamped ?? 0) >= 0.36) {
      expect(r.warnings.some((w) => /художественн|прозы|диалога/i.test(w))).toBe(true)
    }
  })
})

describe('analyzeSubtitles', () => {
  it('computes subtitle metrics and segments', () => {
    const segments = [
      { text: 'Uma frase curta.', startMs: 0, endMs: 2000 },
      { text: 'Outra linha com mais palavras para testar o ritmo.', startMs: 2000, endMs: 5000 },
      { text: 'Terceira.', startMs: 5000, endMs: 6500 },
      { text: 'Quarta com conteúdo.', startMs: 6500, endMs: 9000 },
      { text: 'Quinta.', startMs: 9000, endMs: 10500 },
    ]
    const r = analyzeSubtitles({ segments, videoDurationMs: 12000, variant: 'pt-BR' })
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
    expect(r.features.segmentCount).toBeGreaterThan(0)
    expect(r.features.readingSpeedCps).toBeGreaterThan(0)
    expect(r.segments.length).toBeGreaterThan(0)
    expect(r.contributions.subtitleReadingSpeed).toBeGreaterThan(0)
  })
})
