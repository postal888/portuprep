/**
 * Vite Connect middleware: difficulty API + GET /api/health
 */
import type { Connect } from 'vite'
import type { IncomingMessage } from 'node:http'
import { analyzePlainText, analyzeSubtitles } from './analyze.ts'
import type { DifficultyAnalysisResult, SubtitleSegmentInput } from './types.ts'
import type { ContentGenre } from './types.ts'
import {
  appendAnalysis,
  findLatest,
  hashContent,
  historyList,
  newAnalysisId,
  type SourceType,
  type StoredDifficultyAnalysis,
} from './persistence-store.ts'

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function pathOnly(url: string | undefined): string {
  if (!url) return ''
  const q = url.indexOf('?')
  return q >= 0 ? url.slice(0, q) : url
}

function toApiBody(
  stored: StoredDifficultyAnalysis,
  full: DifficultyAnalysisResult,
): Record<string, unknown> {
  return {
    analysisId: stored.id,
    sourceType: stored.sourceType,
    sourceId: stored.sourceId,
    sourceVersionHash: stored.sourceVersionHash,
    mode: stored.mode,
    variant: stored.variant,
    userId: stored.userId,
    probableGenre: (stored.probableGenre as ContentGenre | undefined) ?? full.probableGenre,
    score: full.score,
    band: full.band,
    cefrEstimate: full.cefrEstimate,
    learnerComprehensionDifficulty: full.learnerComprehensionDifficulty ?? full.score,
    learner_comprehension_difficulty: full.learnerComprehensionDifficulty ?? full.score,
    learnerBand: full.learnerBand ?? full.band,
    learnerCefrEstimate: full.learnerCefrEstimate ?? full.cefrEstimate,
    confidence: full.confidence,
    reasons: full.reasons,
    warnings: full.warnings,
    features: full.features,
    contributions: full.contributions,
    segments: full.segments,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  }
}

function makeStored(
  id: string,
  userId: string,
  sourceType: SourceType,
  sourceId: string,
  contentForHash: string,
  variant: 'pt-BR' | 'pt-PT',
  mode: 'text' | 'subtitles',
  r: DifficultyAnalysisResult,
): StoredDifficultyAnalysis {
  const iso = new Date().toISOString()
  return {
    id,
    userId,
    sourceType,
    sourceId,
    sourceVersionHash: contentForHash ? hashContent(contentForHash) : null,
    variant,
    mode,
    probableGenre: r.probableGenre,
    score: r.score,
    band: r.band,
    cefrEstimate: r.cefrEstimate,
    learnerComprehensionDifficulty: r.learnerComprehensionDifficulty ?? r.score,
    learnerBand: r.learnerBand ?? r.band,
    learnerCefrEstimate: r.learnerCefrEstimate ?? r.cefrEstimate,
    confidence: r.confidence,
    reasons: r.reasons,
    warnings: r.warnings,
    features: r.features,
    contributions: r.contributions,
    segments: r.segments,
    createdAt: iso,
    updatedAt: iso,
  }
}

export function createHealthHandler(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' || pathOnly(req.url) !== '/api/health') {
      next()
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, service: 'portuprep', difficulty: true }))
  }
}

export function createDifficultyApiHandler(storePath: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const p = pathOnly(req.url)
    if (!p.startsWith('/api/difficulty')) {
      next()
      return
    }

    void (async () => {
      try {
        if (req.method === 'GET' && p === '/api/difficulty/latest') {
          const u = new URL(req.url || '', 'http://local')
          const st = u.searchParams.get('sourceType') as SourceType | null
          const sid = u.searchParams.get('sourceId')
          if (!st || (st !== 'TEXT' && st !== 'VIDEO') || !sid) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'Query params required: sourceType=TEXT|VIDEO and sourceId' }))
            return
          }
          const latest = findLatest(st, sid, storePath)
          if (!latest) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'No analysis found for this source' }))
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              analysisId: latest.id,
              sourceType: latest.sourceType,
              sourceId: latest.sourceId,
              sourceVersionHash: latest.sourceVersionHash,
              mode: latest.mode,
              variant: latest.variant,
              probableGenre: latest.probableGenre ?? 'informative',
              score: latest.score,
              band: latest.band,
              cefrEstimate: latest.cefrEstimate,
              learnerComprehensionDifficulty: latest.learnerComprehensionDifficulty ?? latest.score,
              learner_comprehension_difficulty:
                latest.learnerComprehensionDifficulty ?? latest.score,
              learnerBand: latest.learnerBand ?? latest.band,
              learnerCefrEstimate: latest.learnerCefrEstimate ?? latest.cefrEstimate,
              confidence: latest.confidence,
              reasons: latest.reasons,
              warnings: latest.warnings,
              features: latest.features,
              contributions: latest.contributions,
              segments: latest.segments,
              createdAt: latest.createdAt,
              updatedAt: latest.updatedAt,
            }),
          )
          return
        }

        if (req.method === 'GET' && p === '/api/difficulty/history') {
          const u = new URL(req.url || '', 'http://local')
          const st = u.searchParams.get('sourceType') as SourceType | null
          const sid = u.searchParams.get('sourceId')
          const lim = parseInt(u.searchParams.get('limit') || '50', 10)
          const list = historyList(st, sid, Number.isFinite(lim) ? lim : 50, storePath)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ analyses: list }))
          return
        }

        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Allow', 'GET, POST')
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        const rawBody = await readJsonBody(req)
        let body: Record<string, unknown>
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }

        const userId = typeof body.userId === 'string' ? body.userId : 'default'
        const variant = body.variant === 'pt-PT' ? 'pt-PT' : 'pt-BR'

        if (p === '/api/difficulty/analyze') {
          const mode = body.mode === 'subtitles' ? 'subtitles' : 'text'
          if (mode === 'text') {
            const text = typeof body.text === 'string' ? body.text : ''
            if (text.trim().length < 2) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ error: 'Empty or too short text' }))
              return
            }
            const r = analyzePlainText({ text, variant })
            const id = newAnalysisId()
            const st = makeStored(id, userId, 'TEXT', 'inline', text, variant, 'text', r)
            appendAnalysis(st, storePath)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(toApiBody(st, r)))
            return
          }
          const segments = body.segments as unknown
          const vidMs =
            typeof body.videoDurationMs === 'number' && Number.isFinite(body.videoDurationMs)
              ? body.videoDurationMs
              : null
          if (!Array.isArray(segments) || segments.length === 0) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'Expected segments: array of { text, startMs, endMs }' }))
            return
          }
          const norm: SubtitleSegmentInput[] = segments.map((s: unknown) => {
            const o = s as Record<string, unknown>
            return {
              text: typeof o.text === 'string' ? o.text : '',
              startMs: typeof o.startMs === 'number' ? o.startMs : 0,
              endMs: typeof o.endMs === 'number' ? o.endMs : 0,
            }
          })
          const r = analyzeSubtitles({ segments: norm, videoDurationMs: vidMs ?? undefined, variant })
          const id = newAnalysisId()
          const merged = norm.map((s) => s.text).join(' ')
          const st = makeStored(id, userId, 'VIDEO', 'inline', merged, variant, 'subtitles', r)
          appendAnalysis(st, storePath)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(toApiBody(st, r)))
          return
        }

        if (p === '/api/difficulty/analyze-by-text-id') {
          const textId = typeof body.textId === 'string' ? body.textId : ''
          const plainText = typeof body.plainText === 'string' ? body.plainText : ''
          if (!textId.trim() || plainText.trim().length < 2) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'textId and plainText are required' }))
            return
          }
          const r = analyzePlainText({ text: plainText, variant })
          const id = newAnalysisId()
          const st = makeStored(id, userId, 'TEXT', textId, plainText, variant, 'text', r)
          appendAnalysis(st, storePath)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(toApiBody(st, r)))
          return
        }

        if (p === '/api/difficulty/analyze-by-video-id') {
          const videoId = typeof body.videoId === 'string' ? body.videoId : ''
          const segments = body.segments as unknown
          const vidMs =
            typeof body.videoDurationMs === 'number' && Number.isFinite(body.videoDurationMs)
              ? body.videoDurationMs
              : null
          if (!videoId.trim()) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'videoId is required' }))
            return
          }
          if (!Array.isArray(segments) || segments.length === 0) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(
              JSON.stringify({
                error: 'No subtitles loaded. Generate or fetch subtitles for this video first.',
                code: 'NO_TRANSCRIPT',
              }),
            )
            return
          }
          const norm: SubtitleSegmentInput[] = (segments as Record<string, unknown>[]).map((o) => ({
            text: typeof o.text === 'string' ? o.text : '',
            startMs: typeof o.startMs === 'number' ? o.startMs : 0,
            endMs: typeof o.endMs === 'number' ? o.endMs : 0,
          }))
          const r = analyzeSubtitles({ segments: norm, videoDurationMs: vidMs ?? undefined, variant })
          const id = newAnalysisId()
          const merged = norm.map((s) => s.text).join(' ')
          const st = makeStored(id, userId, 'VIDEO', `yt:${videoId}`, merged, variant, 'subtitles', r)
          appendAnalysis(st, storePath)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(toApiBody(st, r)))
          return
        }

        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'Unknown difficulty API path' }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }
}
