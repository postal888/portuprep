import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Connect } from 'vite'
import type { LoadParameters } from 'pdf-parse'
import { PDFParse } from 'pdf-parse'
import * as mammoth from 'mammoth'

const INDEX_VERSION = 2 as const
const CHUNK_SIZE = 2200
const CHUNK_OVERLAP = 200
/** При скользящем окне; короткие страницы целиком попадают в индекс через ветку cleaned.length <= size. */
const MIN_CHUNK_LEN = 8

const nodeRequire = createRequire(import.meta.url)

/** Без cMapUrl pdf.js в Node часто возвращает пустой текст для PDF с кириллицей и нестандартными шрифтами. */
function buildPdfLoadParams(buf: Buffer): LoadParameters {
  const opts: LoadParameters = {
    data: Buffer.from(buf),
    useSystemFonts: true,
  }
  try {
    const pdfRoot = dirname(nodeRequire.resolve('pdfjs-dist/package.json'))
    opts.cMapUrl = pathToFileURL(join(pdfRoot, 'cmaps') + '/').href
    opts.cMapPacked = true
  } catch {
    /* остаётся дефолт pdf.js */
  }
  return opts
}

export type BigDictChunk = { id: number; page: number; t: string }
type BigDictSourceKind = 'pdf' | 'docx'

export type BigDictIndexFile = {
  version: typeof INDEX_VERSION
  sourcePath: string
  sourceMtimeMs: number
  sourceKind: BigDictSourceKind
  builtAt: string
  chunkSize: number
  chunkOverlap: number
  chunks: BigDictChunk[]
  stats?: { sourceKind: BigDictSourceKind; pageCount: number | null; extractedChars: number }
}

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function chunkLongText(s: string, size: number, overlap: number): string[] {
  const cleaned = s.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim()
  if (!cleaned.length) return []
  if (cleaned.length <= size) return [cleaned]
  const out: string[] = []
  let i = 0
  while (i < cleaned.length) {
    const end = Math.min(i + size, cleaned.length)
    const slice = cleaned.slice(i, end).trim()
    if (slice.length >= MIN_CHUNK_LEN) out.push(slice)
    if (end >= cleaned.length) break
    const nextStart = end - overlap
    i = nextStart > i ? nextStart : i + 1
  }
  return out
}

function normalizeForSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

function tokenizeQuery(q: string): string[] {
  const n = normalizeForSearch(q)
  return n
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 || (t.length === 1 && /[a-zа-яё]/i.test(t)))
}

function scoreChunk(chunkNorm: string, tokens: string[]): number {
  let score = 0
  for (const tok of tokens) {
    if (!tok || tok.length < 1) continue
    let pos = 0
    let hits = 0
    while (pos < chunkNorm.length) {
      const ix = chunkNorm.indexOf(tok, pos)
      if (ix === -1) break
      hits++
      pos = ix + Math.max(1, tok.length)
    }
    const w = tok.length >= 5 ? 5 : tok.length >= 4 ? 3 : tok.length >= 3 ? 2 : 1
    score += hits * w
    if (hits > 0) {
      const atWord = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(tok)}([^\\p{L}\\p{N}]|$)`, 'u')
      if (atWord.test(chunkNorm)) score += 3
    }
  }
  return score
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeSnippet(text: string, tokens: string[], maxLen: number): string {
  const norm = normalizeForSearch(text)
  let bestIx = -1
  let bestTok = ''
  for (const tok of tokens) {
    if (!tok) continue
    const ix = norm.indexOf(tok)
    if (ix !== -1 && (bestIx === -1 || ix < bestIx)) {
      bestIx = ix
      bestTok = tok
    }
  }
  if (bestIx === -1) return text.length <= maxLen ? text : text.slice(0, maxLen) + '…'
  const pad = Math.floor((maxLen - bestTok.length) / 2)
  const start = Math.max(0, bestIx - pad)
  const end = Math.min(text.length, start + maxLen)
  let sn = text.slice(start, end)
  if (start > 0) sn = '…' + sn
  if (end < text.length) sn = sn + '…'
  return sn
}

function splitDictEntries(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
}

function isLikelyDictPairLine(s: string): boolean {
  if (s.length < 4 || s.length > 1200) return false
  if (!/^[a-zà-öø-ÿ]/i.test(s)) return false
  if (!/[a-zà-öø-ÿ]/i.test(s)) return false
  if (!/[а-яё]/i.test(s)) return false
  return true
}

function extractSearchEntries(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const t = raw.replace(/\s+/g, ' ').trim()
    if (!isLikelyDictPairLine(t)) return
    const k = normalizeForSearch(t)
    if (seen.has(k)) return
    seen.add(k)
    out.push(t)
  }
  for (const para of splitDictEntries(text)) {
    push(para)
    for (const line of para.split('\n')) push(line)
  }
  return out
}

function extractHeadword(entry: string): string {
  const m = normalizeForSearch(entry).match(/^[a-zà-öø-ÿ][a-zà-öø-ÿ'-]*/i)
  return (m?.[0] || '').trim()
}

function isPlainLemmaEntry(entryNorm: string, qNorm: string): boolean {
  if (!entryNorm.startsWith(qNorm)) return false
  const after = entryNorm.slice(qNorm.length).trimStart()
  if (!after) return true
  if (/^(?:\*|\d|[([{.,;:])/u.test(after)) return true
  if (/^(?:m|f|n|adj|adv|vt|vi|v\.|interj|prep|pron|conj|art)\b/u.test(after)) return true
  if (/^[a-zà-öø-ÿ]{1,8}\b/u.test(after)) return false
  return false
}

function detectQueryScript(q: string): 'pt' | 'ru' | 'mixed' {
  const hasRu = /[а-яё]/i.test(q)
  const hasPt = /[a-zà-öø-ÿ]/i.test(q)
  if (hasRu && hasPt) return 'mixed'
  if (hasRu) return 'ru'
  return 'pt'
}

function scoreEntryForDirection(
  entry: string,
  qNorm: string,
  baseScore: number,
  script: 'pt' | 'ru' | 'mixed',
): number {
  let score = baseScore
  const entryNorm = normalizeForSearch(entry)
  const headword = extractHeadword(entryNorm)
  if (script === 'pt') {
    // Для PT-запроса усиливаем попадания в начало словарной статьи (обычно лемма).
    const startsWithHeadword = new RegExp(`^${escapeRegExp(qNorm)}([\\s,;:.()\\-]|$)`, 'u').test(entryNorm)
    if (headword && headword === qNorm) {
      score += isPlainLemmaEntry(entryNorm, qNorm) ? 800 : 240
    }
    else if (headword && headword.startsWith(qNorm)) score += 180
    if (startsWithHeadword) score += 60
  } else if (script === 'ru') {
    // Для RU-запроса усиливаем строки, где есть русская часть и португальская лемма в начале.
    const hasRuInEntry = /[а-яё]/i.test(entry)
    const hasPtHeadword = !!headword
    if (hasRuInEntry) score += 6
    if (hasPtHeadword) score += 12
  }
  return score
}

let cachedIndex: BigDictIndexFile | null = null
let cachedIndexPath = ''
let cachedIndexMtime = 0
let reindexPromise: Promise<void> | null = null

function loadIndexFromDisk(indexPath: string): BigDictIndexFile | null {
  if (!existsSync(indexPath)) return null
  try {
    const st = statSync(indexPath)
    if (cachedIndex && cachedIndexPath === indexPath && st.mtimeMs === cachedIndexMtime) {
      return cachedIndex
    }
    const raw = readFileSync(indexPath, 'utf8')
    const parsed = JSON.parse(raw) as BigDictIndexFile
    if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.chunks)) return null
    cachedIndex = parsed
    cachedIndexPath = indexPath
    cachedIndexMtime = st.mtimeMs
    return parsed
  } catch {
    return null
  }
}

function invalidateIndexCache() {
  cachedIndex = null
  cachedIndexPath = ''
  cachedIndexMtime = 0
}

async function extractPdfChunks(sourcePath: string): Promise<{
  chunks: BigDictChunk[]
  pageCount: number
  extractedChars: number
}> {
  const buf = readFileSync(sourcePath)
  const parser = new PDFParse(buildPdfLoadParams(buf))
  let result: Awaited<ReturnType<PDFParse['getText']>>
  try {
    result = await parser.getText()
  } finally {
    await parser.destroy()
  }

  const pageCount = result.total
  const extractedChars = (result.text || '').trim().length
  const chunks: BigDictChunk[] = []
  let id = 0
  for (const page of result.pages) {
    const parts = chunkLongText(page.text || '', CHUNK_SIZE, CHUNK_OVERLAP)
    for (const t of parts) {
      chunks.push({ id: id++, page: page.num, t })
    }
  }

  if (chunks.length === 0 && extractedChars > 0) {
    const parts = chunkLongText(result.text || '', CHUNK_SIZE, CHUNK_OVERLAP)
    for (const t of parts) {
      chunks.push({ id: id++, page: 0, t })
    }
  }

  if (chunks.length === 0) {
    throw new Error(
      pageCount === 0
        ? 'PDF не содержит страниц или не удалось открыть файл.'
        : extractedChars === 0
          ? 'Из PDF не извлечён текст (0 символов). Часто это скан без слоя текста (нужен OCR) или повреждённый файл. Убедитесь, что в программе для PDF текст можно выделить мышью.'
          : 'Текст есть, но не удалось разбить на фрагменты — сообщите разработчику.',
    )
  }
  return { chunks, pageCount, extractedChars }
}

async function extractDocxChunks(sourcePath: string): Promise<{
  chunks: BigDictChunk[]
  extractedChars: number
}> {
  const { value } = await mammoth.extractRawText({ path: sourcePath })
  const text = (value || '').replace(/\r\n/g, '\n')
  const extractedChars = text.trim().length
  if (!extractedChars) {
    throw new Error('Из DOCX не извлечён текст (0 символов). Проверьте, что файл не пустой и не повреждён.')
  }
  const parts = chunkLongText(text, CHUNK_SIZE, CHUNK_OVERLAP)
  const chunks: BigDictChunk[] = parts.map((t, id) => ({ id, page: 0, t }))
  if (!chunks.length) {
    throw new Error('Текст из DOCX извлечён, но не удалось разбить на фрагменты.')
  }
  return { chunks, extractedChars }
}

function detectSourceKind(sourcePath: string): BigDictSourceKind | null {
  const ext = extname(sourcePath).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  return null
}

async function buildIndexFile(sourcePath: string, indexPath: string): Promise<BigDictIndexFile> {
  const sourceKind = detectSourceKind(sourcePath)
  if (!sourceKind) {
    throw new Error(
      'Неподдерживаемый формат словаря. Используйте .pdf или .docx (для .doc сначала сохраните как .docx).',
    )
  }
  const st = statSync(sourcePath)
  let chunks: BigDictChunk[] = []
  let pageCount: number | null = null
  let extractedChars = 0
  if (sourceKind === 'pdf') {
    const pdf = await extractPdfChunks(sourcePath)
    chunks = pdf.chunks
    pageCount = pdf.pageCount
    extractedChars = pdf.extractedChars
  } else {
    const docx = await extractDocxChunks(sourcePath)
    chunks = docx.chunks
    extractedChars = docx.extractedChars
  }

  const index: BigDictIndexFile = {
    version: INDEX_VERSION,
    sourcePath,
    sourceMtimeMs: st.mtimeMs,
    sourceKind,
    builtAt: new Date().toISOString(),
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    chunks,
    stats: { sourceKind, pageCount, extractedChars },
  }
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify(index), 'utf8')
  invalidateIndexCache()
  return index
}

function searchInIndex(index: BigDictIndexFile, q: string, limit: number) {
  const tokens = tokenizeQuery(q)
  if (!tokens.length) return { results: [] as { id: number; page: number; score: number; snippet: string }[] }
  const qNorm = normalizeForSearch(q.trim())
  const script = detectQueryScript(qNorm)
  const scored: { id: number; page: number; score: number; snippet: string }[] = []
  const strictPt: { id: number; page: number; score: number; snippet: string }[] = []
  for (const ch of index.chunks) {
    const entries = extractSearchEntries(ch.t)
    for (const entry of entries) {
      const norm = normalizeForSearch(entry)
      const base = scoreChunk(norm, tokens)
      if (base <= 0) continue
      const sc = scoreEntryForDirection(entry, qNorm, base, script)
      if (sc <= 0) continue
      const hit = {
        id: ch.id,
        page: ch.page,
        score: sc,
        snippet: makeSnippet(entry, tokens, 960),
      }
      scored.push(hit)
      if (script === 'pt') {
        const hw = extractHeadword(entry)
        if (hw === qNorm || hw.startsWith(qNorm)) strictPt.push(hit)
      }
    }
  }
  const source = script === 'pt' && strictPt.length ? strictPt : scored
  const dedup = new Map<string, { id: number; page: number; score: number; snippet: string }>()
  for (const hit of source) {
    const key = normalizeForSearch(hit.snippet)
    const prev = dedup.get(key)
    if (!prev || hit.score > prev.score) dedup.set(key, hit)
  }
  const unique = [...dedup.values()]
  unique.sort((a, b) => b.score - a.score || a.page - b.page)
  return { results: unique.slice(0, limit) }
}

async function openaiSynthesizeFromSnippets(
  query: string,
  snippets: string[],
  apiKey: string,
): Promise<string> {
  const joined = snippets
    .slice(0, 6)
    .map((s, i) => `Фрагмент ${i + 1}:\n${s.slice(0, 3200)}`)
    .join('\n\n')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Ты помощник по португальско-русскому словарю. Отвечай по-русски, кратко. Используй только сведения из приведённых фрагментов словаря. Если по фрагментам нельзя понять значение запроса, так и скажи.',
        },
        {
          role: 'user',
          content: `Запрос (слово или фраза на португальском или русском): «${query.trim().slice(0, 200)}»\n\n${joined}`,
        },
      ],
      temperature: 0.15,
      max_tokens: 600,
    }),
  })
  const raw = (await res.json()) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] }
  if (!res.ok) {
    throw new Error(raw.error?.message || `OpenAI HTTP ${res.status}`)
  }
  return (raw.choices?.[0]?.message?.content || '').trim()
}

export type BigDictApiOpts = {
  /** Абсолютный или относительный путь к файлу словаря на машине разработчика (.pdf или .docx) */
  sourcePath?: string
  /** Набор источников по id (например: { main: '...docx', tolkovy: '...pdf' }) */
  sources?: Record<string, string>
  /** Legacy-поле для обратной совместимости с текущим vite.config */
  pdfPath?: string
  /** Каталог data/ проекта */
  dataDir: string
  openaiKey?: string
}

export function createBigDictApiHandler(opts: BigDictApiOpts): Connect.NextHandleFunction {
  const DEFAULT_SOURCE_ID = 'main'
  const sourceMap: Record<string, string> = {}
  if (opts.sources && typeof opts.sources === 'object') {
    for (const [k, v] of Object.entries(opts.sources)) {
      const id = String(k || '').trim().toLowerCase()
      const path = String(v || '').trim()
      if (id && path) sourceMap[id] = path
    }
  }
  const legacySource = (opts.sourcePath || opts.pdfPath || '').trim()
  if (legacySource && !sourceMap[DEFAULT_SOURCE_ID]) sourceMap[DEFAULT_SOURCE_ID] = legacySource

  function listSources() {
    const ids = Object.keys(sourceMap)
    return ids.map((id) => {
      const path = sourceMap[id]
      return {
        id,
        label: id === DEFAULT_SOURCE_ID ? 'Основной словарь' : id === 'tolkovy' ? 'Толковый словарь' : id,
        sourcePath: path,
        sourceKind: path ? detectSourceKind(path) : null,
        configured: !!path,
        sourceExists: !!(path && existsSync(path)),
      }
    })
  }

  function pickSourceId(rawId: unknown): string {
    const req = String(rawId || '').trim().toLowerCase()
    if (req && sourceMap[req]) return req
    if (sourceMap[DEFAULT_SOURCE_ID]) return DEFAULT_SOURCE_ID
    const first = Object.keys(sourceMap)[0]
    return first || DEFAULT_SOURCE_ID
  }

  function sourceIndexPath(sourceId: string): string {
    const safeId = String(sourceId || DEFAULT_SOURCE_ID).replace(/[^a-z0-9_-]/gi, '_')
    return join(opts.dataDir, 'big-pt-ru-dict', `index-${safeId}.json`)
  }

  async function ensureFreshIndexIfNeeded(sourceId: string): Promise<BigDictIndexFile | null> {
    const sourcePath = sourceMap[sourceId]
    const indexPath = sourceIndexPath(sourceId)
    if (!sourcePath || !existsSync(sourcePath)) return loadIndexFromDisk(indexPath)
    const sourceMtime = statSync(sourcePath).mtimeMs
    const idx = loadIndexFromDisk(indexPath)
    const stale = !idx || idx.sourcePath !== sourcePath || Math.abs((idx.sourceMtimeMs || 0) - sourceMtime) > 1
    if (!stale) return idx
    if (!reindexPromise) {
      reindexPromise = (async () => {
        await buildIndexFile(sourcePath, indexPath)
      })().finally(() => {
        reindexPromise = null
      })
    }
    await reindexPromise
    return loadIndexFromDisk(indexPath)
  }

  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split('?')[0] || ''
    if (!url.startsWith('/api/big-dict')) {
      next()
      return
    }

    void (async () => {
      try {
        if (url === '/api/big-dict/status' && req.method === 'GET') {
          const u = new URL(req.url || '', 'http://localhost')
          const sourceId = pickSourceId(u.searchParams.get('source'))
          const sourcePath = sourceMap[sourceId]
          const indexPath = sourceIndexPath(sourceId)
          const hasSource = !!(sourcePath && existsSync(sourcePath))
          let sourceMtime = 0
          if (hasSource) sourceMtime = statSync(sourcePath!).mtimeMs
          const idx = loadIndexFromDisk(indexPath)
          const sourceKind = sourcePath ? detectSourceKind(sourcePath) : null
          const needsReindex = hasSource && (!idx || idx.sourcePath !== sourcePath || Math.abs(idx.sourceMtimeMs - sourceMtime) > 1)
          const selected = listSources().find((s) => s.id === sourceId)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              sourceId,
              sourceLabel: selected?.label || sourceId,
              configured: !!sourcePath,
              sourceExists: hasSource,
              sourcePath: sourcePath || null,
              sourceKind: sourceKind || idx?.sourceKind || null,
              indexed: !!idx && !needsReindex,
              chunkCount: idx?.chunks.length ?? 0,
              builtAt: idx?.builtAt ?? null,
              needsReindex: !!needsReindex,
              canSynthesize: !!opts.openaiKey,
              pageCount: idx?.stats?.pageCount ?? null,
              extractedChars: idx?.stats?.extractedChars ?? null,
              indexEmpty: !!(idx && idx.chunks.length === 0),
              availableSources: listSources(),
            }),
          )
          return
        }

        if (url === '/api/big-dict/reindex' && req.method === 'POST') {
          const rawBody = await readJsonBody(req)
          let body: { source?: string } = {}
          try {
            body = JSON.parse(rawBody || '{}') as { source?: string }
          } catch {
            body = {}
          }
          const sourceId = pickSourceId(body.source)
          const sourcePath = sourceMap[sourceId]
          const indexPath = sourceIndexPath(sourceId)
          if (!sourcePath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: `Для источника "${sourceId}" не задан путь к файлу словаря.` }))
            return
          }
          if (!existsSync(sourcePath)) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: `Файл не найден: ${sourcePath}` }))
            return
          }
          if (!reindexPromise) {
            reindexPromise = (async () => {
              await buildIndexFile(sourcePath, indexPath)
            })().finally(() => {
              reindexPromise = null
            })
          }
          await reindexPromise
          const idx = loadIndexFromDisk(indexPath)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              ok: true,
              sourceId,
              chunkCount: idx?.chunks.length ?? 0,
              builtAt: idx?.builtAt ?? null,
            }),
          )
          return
        }

        if (url === '/api/big-dict/search' && req.method === 'POST') {
          const rawBody = await readJsonBody(req)
          let body: { q?: string; limit?: number; synthesize?: boolean; source?: string }
          try {
            body = JSON.parse(rawBody) as { q?: string; limit?: number; synthesize?: boolean; source?: string }
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'Invalid JSON' }))
            return
          }
          const sourceId = pickSourceId(body.source)
          const q = typeof body.q === 'string' ? body.q.trim() : ''
          if (!q || q.length < 2) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'Введите запрос (от 2 символов)' }))
            return
          }
          const idx = await ensureFreshIndexIfNeeded(sourceId)
          if (!idx) {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(
              JSON.stringify({
                error: `Индекс для источника "${sourceId}" не построен. Нажмите «Построить / обновить индекс».`,
              }),
            )
            return
          }
          if (idx.chunks.length === 0) {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(
              JSON.stringify({
                error: 'Индекс пустой. Нажмите «Построить индекс» снова. Для PDF возможна причина: скан без OCR.',
              }),
            )
            return
          }
          const limit = Math.min(25, Math.max(5, Number(body.limit) || 15))
          const { results } = searchInIndex(idx, q, limit)
          let synthesis: string | null = null
          if (body.synthesize && opts.openaiKey && results.length) {
            const fullTexts = results
              .map((r) => {
                const ch = idx.chunks.find((c) => c.id === r.id)
                return ch ? ch.t : r.snippet
              })
              .filter(Boolean)
            try {
              synthesis = await openaiSynthesizeFromSnippets(q, fullTexts, opts.openaiKey)
            } catch (e) {
              synthesis = null
            }
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ sourceId, results, synthesis }))
          return
        }

        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'Not found' }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  return handler
}
