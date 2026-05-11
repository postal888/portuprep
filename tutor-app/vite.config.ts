import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import type { Connect, PreviewServer, ViteDevServer } from 'vite'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import ytdl from '@distube/ytdl-core'
import { createBigDictApiHandler } from './lib/big-dict/vite-middleware.ts'
import { createDifficultyApiHandler, createHealthHandler } from './lib/difficulty/vite-middleware.ts'
import { fetchYoutubeTranscriptRobust } from './lib/youtube-transcript-extra.ts'

/** Каталог `tutor-app/` (рядом с этим vite.config.ts). */
const viteConfigDir = dirname(fileURLToPath(import.meta.url))
const vocabularyDir = join(viteConfigDir, 'vocabulary')
const vocabularyFile = join(vocabularyDir, 'words.json')
const vocabImagesDir = join(viteConfigDir, 'public', 'vocab-images')
const dataDir = join(viteConfigDir, 'data')
const ytOfflineVideoDir = join(dataDir, 'youtube-offline-videos')
const fleStudyLogFile = join(dataDir, 'fle-study-log.json')
const difficultyAnalysesFile = join(dataDir, 'difficulty-analyses.json')
const FLE_STUDY_LOG_MAX_EVENTS = 15_000

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseGlossJson(content: string): Record<string, string> {
  let t = content.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const obj = JSON.parse(t) as unknown
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Model returned non-object JSON')
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
  }
  return out
}

/** Сопоставление леммы с ключами глосса (модель может отличаться диакритикой). */
function normalizeLemmaKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

function lemmaResolvedInGloss(gloss: Record<string, string>, lemma: string): boolean {
  const L = lemma.toLowerCase()
  const v = gloss[L]
  if (typeof v === 'string' && v.trim()) return true
  const n = normalizeLemmaKey(L)
  for (const [k, val] of Object.entries(gloss)) {
    if (typeof val !== 'string' || !val.trim()) continue
    if (normalizeLemmaKey(k) === n) return true
  }
  return false
}

async function openaiTranslateWords(words: string[], apiKey: string): Promise<Record<string, string>> {
  const prompt = `Portuguese tokens from subtitles (may be 1 letter, e.g. "e", "a", "o"). Return ONE JSON object ONLY.

Rules:
- Keys MUST be EXACTLY the strings from the Words array below (lowercase). Include EVERY word — do not omit articles, conjunctions, pronouns, or clitics.
- Values: short Russian gloss (1–7 words).

Words (JSON array):
${JSON.stringify(words)}`

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
            'Reply with a single JSON object only. Each key from the user list must appear exactly once. Values: Russian gloss. No markdown, no code fences.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.12,
      max_tokens: Math.min(16384, words.length * 28 + 600),
    }),
  })

  const raw = (await res.json()) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] }
  if (!res.ok) {
    throw new Error(raw.error?.message || `OpenAI HTTP ${res.status}`)
  }
  const text = raw.choices?.[0]?.message?.content || ''
  try {
    return parseGlossJson(text)
  } catch {
    return {}
  }
}

async function buildGlossWithGapPasses(unique: string[], apiKey: string): Promise<Record<string, string>> {
  const gloss: Record<string, string> = {}
  const batchSize = 72
  const batches: string[][] = []
  for (let i = 0; i < unique.length; i += batchSize) batches.push(unique.slice(i, i + batchSize))

  for (const batch of batches) {
    const part = await openaiTranslateWords(batch, apiKey)
    Object.assign(gloss, part)
  }

  let missing = unique.filter((w) => !lemmaResolvedInGloss(gloss, w))
  for (let pass = 0; pass < 4 && missing.length; pass++) {
    const part = await openaiTranslateWords(missing, apiKey)
    const before = missing.length
    Object.assign(gloss, part)
    missing = unique.filter((w) => !lemmaResolvedInGloss(gloss, w))
    if (missing.length >= before) {
      const smaller = chunk(missing, Math.max(8, Math.ceil(missing.length / 2)))
      for (const sub of smaller) {
        Object.assign(gloss, await openaiTranslateWords(sub, apiKey))
      }
      missing = unique.filter((w) => !lemmaResolvedInGloss(gloss, w))
    }
  }
  return gloss
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Убирает типичные вводные про «во фрагменте есть грамматика», если модель их всё же вернула. */
function stripConstructionExplainLead(s: string): string {
  const leadPatterns = [
    /^(?:В данном фрагменте|В этом фрагменте|В выделенном фрагменте|В этом отрывке|В приведённом фрагменте|В приведенном фрагменте|В указанном фрагменте)[^.:\n]{0,240}(?:\.|:)\s*/imu,
    /^(?:Здесь|Тут) (?:присутствует|есть|используется|встречается)(?:\s+несколько)?[^.:\n]{0,160}(?:\.|:)\s*/imu,
    /^(?:Рассмотрим|Разберём|Разберем) (?:этот )?(?:фрагмент|отрывок)[^.:\n]{0,120}(?:\.|:)\s*/imu,
  ]
  let t = s.trim()
  for (let pass = 0; pass < 3; pass++) {
    const before = t
    for (const re of leadPatterns) {
      t = t.replace(re, '')
    }
    t = t.trim()
    if (t === before) break
  }
  return t
}

async function openaiTranslateBookPassage(text: string, apiKey: string): Promise<string> {
  const body = text.trim().slice(0, 12_000)
  if (body.length < 2) return ''
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
            'Переводи с бразильского португальского на русский. Сохраняй абзацы и диалоги. Только перевод, без комментариев и кавычек вокруг всего текста.',
        },
        { role: 'user', content: body },
      ],
      temperature: 0.2,
      max_tokens: 4500,
    }),
  })
  const raw = (await res.json()) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] }
  if (!res.ok) {
    throw new Error(raw.error?.message || `OpenAI HTTP ${res.status}`)
  }
  return (raw.choices?.[0]?.message?.content || '').trim()
}

async function openaiExplainPortugueseConstruction(fragment: string, apiKey: string): Promise<string> {
  const text = fragment.trim().slice(0, 2800)
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
            'Ты помощник по португальскому языку. Отвечай на русском. Объясняй грамматику, устойчивые выражения, порядок слов и смысл фрагмента для изучающего.\n' +
            'Пиши сразу по существу: без вводных вроде «Конечно», без мета-абзацев вроде «В данном фрагменте присутствует несколько важных элементов…», «В этом отрывке рассматриваются…» — начинай с первого конкретного пункта разбора.\n' +
            'Структурируй абзацами или нумерацией при необходимости.',
        },
        {
          role: 'user',
          content: `Разбери фрагмент (португальский, из субтитров). Ответ — только разбор, без общих вступлений про то, что во фрагменте есть грамматика или лексика:\n\n${text}`,
        },
      ],
      temperature: 0.35,
      max_tokens: 1400,
    }),
  })
  const raw = (await res.json()) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] }
  if (!res.ok) {
    throw new Error(raw.error?.message || `OpenAI HTTP ${res.status}`)
  }
  return stripConstructionExplainLead((raw.choices?.[0]?.message?.content || '').trim())
}

function parseVocabStoryJson(content: string): { portuguese: string; russian: string } {
  let t = content.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const obj = JSON.parse(t) as unknown
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Model returned non-object JSON')
  }
  const rec = obj as Record<string, unknown>
  const pt = typeof rec.portuguese === 'string' ? rec.portuguese.trim() : ''
  const ru = typeof rec.russian === 'string' ? rec.russian.trim() : ''
  if (!pt || !ru) throw new Error('JSON must include non-empty portuguese and russian')
  return { portuguese: pt, russian: ru }
}

async function openaiVocabStory(
  items: { word: string; translation: string }[],
  style: string,
  length: string,
  hint: string,
  apiKey: string,
): Promise<{ portuguese: string; russian: string }> {
  const payload = JSON.stringify(
    items.map((i) => ({
      pt: i.word.slice(0, 120),
      ru: i.translation.slice(0, 220),
    })),
  )
  const styleRu: Record<string, string> = {
    story: 'связный рассказ или короткая ситуация',
    dialogue: 'диалог двух людей',
    news: 'короткая нейтральная заметка в стиле новости',
    letter: 'короткая записка или неформальное письмо',
    humor: 'лёгкая юмористическая мини-сценка',
  }
  const lenRu: Record<string, string> = {
    short: 'примерно 3–5 предложений',
    medium: 'примерно 6–10 предложений',
    long: 'примерно 11–16 предложений',
  }
  const user =
    `Слова и фразы (JSON). Каждую единицу нужно естественно использовать в тексте (грамматические формы португальского допустимы, смысл узнаваем):\n${payload}\n\n` +
    `Жанр: ${styleRu[style] || styleRu.story}.\n` +
    `Объём: ${lenRu[length] || lenRu.medium}.\n` +
    (hint.trim() ? `Дополнительная тема или контекст: ${hint.trim().slice(0, 500)}\n` : '') +
    `\nНапиши цельный текст на нормативном бразильском португальском (PT-BR). Затем дай полный перевод на русский.\n` +
    `Ответь ОДНИМ JSON-объектом без markdown и без комментариев: {"portuguese":"...","russian":"..."}`

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
            'Ты автор учебных текстов для изучающих португальский (русскоязычная аудитория). Строго отвечай одним JSON-объектом с ключами portuguese и russian — оба строки, без других ключей.',
        },
        { role: 'user', content: user },
      ],
      temperature: 0.55,
      max_tokens: 2200,
    }),
  })
  const raw = (await res.json()) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] }
  if (!res.ok) {
    throw new Error(raw.error?.message || `OpenAI HTTP ${res.status}`)
  }
  const text = (raw.choices?.[0]?.message?.content || '').trim()
  try {
    return parseVocabStoryJson(text)
  } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        return parseVocabStoryJson(m[0])
      } catch {
        /* ignore */
      }
    }
    throw new Error('Не удалось разобрать ответ модели')
  }
}

const VOCAB_CLASSIFY_ALLOWED = [
  'substantivo',
  'verbo',
  'adjetivo',
  'adverbio',
  'pronome',
  'preposição',
  'conjunção',
  'expressão',
  'frase',
  'geral',
] as const

function normalizeVocabClassifyTag(raw: string): (typeof VOCAB_CLASSIFY_ALLOWED)[number] {
  const t = raw.trim().toLowerCase()
  for (const a of VOCAB_CLASSIFY_ALLOWED) {
    if (a === t) return a
    const an = a.normalize('NFD').replace(/\p{M}/gu, '')
    const tn = t.normalize('NFD').replace(/\p{M}/gu, '')
    if (an === tn) return a
  }
  return 'geral'
}

function parseVocabClassifyJson(content: string): { tag: (typeof VOCAB_CLASSIFY_ALLOWED)[number]; infinitivo: string } {
  let t = content.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const obj = JSON.parse(t) as unknown
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Model returned non-object JSON')
  }
  const rec = obj as Record<string, unknown>
  const tagRaw = typeof rec.tag === 'string' ? rec.tag : ''
  const inf = typeof rec.infinitivo === 'string' ? rec.infinitivo.trim() : ''
  return { tag: normalizeVocabClassifyTag(tagRaw), infinitivo: inf }
}

async function openaiClassifyVocabPortuguese(
  word: string,
  translation: string | undefined,
  apiKey: string,
): Promise<{ tag: (typeof VOCAB_CLASSIFY_ALLOWED)[number]; infinitivo: string }> {
  const w = word.trim().slice(0, 500)
  const tr = (translation || '').trim().slice(0, 500)
  const userBlock = `Portuguese headword or phrase: ${JSON.stringify(w)}\nRussian gloss (optional, may be empty): ${JSON.stringify(tr)}`

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
            'You classify Portuguese vocabulary for a Russian learner app. Reply with ONE JSON object only, no markdown fences.\n' +
            'Keys: "tag" (string), "infinitivo" (string).\n' +
            'tag must be exactly one of: substantivo, verbo, adjetivo, adverbio, pronome, preposição, conjunção, expressão, frase, geral\n' +
            'Use "frase" for multi-word sentences or long clauses. Use "expressão" for idioms or short fixed phrases. Use "geral" only if truly ambiguous.\n' +
            'infinitivo: when tag is verbo, the Portuguese infinitive lemma (e.g. falar, comer, partir). If the headword is already an infinitive, repeat it. If conjugated, give the correct infinitive. For any other tag, use empty string "".',
        },
        { role: 'user', content: userBlock },
      ],
      temperature: 0.08,
      max_tokens: 120,
    }),
  })
  const raw = (await res.json()) as { error?: { message?: string }; choices?: { message?: { content?: string } }[] }
  if (!res.ok) {
    throw new Error(raw.error?.message || `OpenAI HTTP ${res.status}`)
  }
  const text = raw.choices?.[0]?.message?.content || ''
  const parsed = parseVocabClassifyJson(text)
  if (parsed.tag === 'verbo' && !parsed.infinitivo) {
    const core = w
      .replace(/^[\u201c\u201d\u00ab\u00bb'"''«»]+|[\u201c\u201d\u00ab\u00bb'"''«»]+$/g, '')
      .replace(/[.,!?;:…]+$/g, '')
      .toLowerCase()
    if (core.length >= 3 && /(?:ar|er|ir)$/.test(core)) parsed.infinitivo = core
  }
  return parsed
}

type FleStudyLog = { version: 1; events: Record<string, unknown>[] }

function newFleStudyEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function readFleStudyLog(): FleStudyLog {
  mkdirSync(dataDir, { recursive: true })
  if (!existsSync(fleStudyLogFile)) return { version: 1, events: [] }
  try {
    const raw = JSON.parse(readFileSync(fleStudyLogFile, 'utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>
      if (r.version === 1 && Array.isArray(r.events)) {
        const events = r.events.filter((e) => e && typeof e === 'object' && !Array.isArray(e)) as Record<
          string,
          unknown
        >[]
        let migrated = false
        for (const ev of events) {
          if (typeof ev.id !== 'string' || !ev.id.trim()) {
            ev.id = newFleStudyEventId()
            migrated = true
          }
        }
        const log: FleStudyLog = { version: 1, events }
        if (migrated) writeFleStudyLog(log)
        return log
      }
    }
  } catch {
    /* ignore */
  }
  return { version: 1, events: [] }
}

function writeFleStudyLog(log: FleStudyLog) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(fleStudyLogFile, JSON.stringify(log, null, 2), 'utf8')
}

function truncFleStr(s: string, n: number): string {
  const t = s.replace(/[\r\n]+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`
}

function normalizeFleStudyEvent(raw: unknown, atIso: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const type = typeof o.type === 'string' ? o.type : ''
  if (type === 'fle_session_start') {
    const sessionId = typeof o.sessionId === 'string' ? truncFleStr(o.sessionId, 96) : ''
    const mode = o.mode === 'errors' || o.mode === 'shuffle' ? o.mode : 'shuffle'
    const uf = o.unitFilter
    const unitFilter: string | number =
      uf === 'all' || uf === '' || uf == null
        ? 'all'
        : typeof uf === 'number' && Number.isFinite(uf)
          ? Math.floor(uf)
          : truncFleStr(String(uf), 24)
    if (!sessionId) return null
    return { id: newFleStudyEventId(), at: atIso, type, sessionId, mode, unitFilter }
  }
  if (type === 'fle_session_end') {
    const sessionId = typeof o.sessionId === 'string' ? truncFleStr(o.sessionId, 96) : ''
    if (!sessionId) return null
    const correct =
      typeof o.correct === 'number' && Number.isFinite(o.correct) ? Math.max(0, Math.floor(o.correct)) : 0
    const wrong =
      typeof o.wrong === 'number' && Number.isFinite(o.wrong) ? Math.max(0, Math.floor(o.wrong)) : 0
    const totalMs =
      typeof o.totalMs === 'number' && Number.isFinite(o.totalMs) ? Math.max(0, Math.floor(o.totalMs)) : 0
    const questionsTotal =
      typeof o.questionsTotal === 'number' && Number.isFinite(o.questionsTotal)
        ? Math.max(0, Math.floor(o.questionsTotal))
        : 0
    return { id: newFleStudyEventId(), at: atIso, type, sessionId, correct, wrong, totalMs, questionsTotal }
  }
  if (type === 'fle_answer') {
    const sessionId = typeof o.sessionId === 'string' ? truncFleStr(o.sessionId, 96) : ''
    if (!sessionId) return null
    const ok = o.ok === true
    const testId = typeof o.testId === 'string' ? truncFleStr(o.testId, 96) : ''
    if (!testId) return null
    const unitId =
      typeof o.unitId === 'number' && Number.isFinite(o.unitId) ? Math.floor(o.unitId) : null
    const grammarTopic = typeof o.grammarTopic === 'string' ? truncFleStr(o.grammarTopic, 220) : ''
    const testType = typeof o.testType === 'string' ? truncFleStr(o.testType, 64) : ''
    const durationMs =
      typeof o.durationMs === 'number' && Number.isFinite(o.durationMs)
        ? Math.max(0, Math.floor(o.durationMs))
        : 0
    const question = typeof o.question === 'string' ? truncFleStr(o.question, 1200) : ''
    const userAnswer = typeof o.userAnswer === 'string' ? truncFleStr(o.userAnswer, 500) : ''
    const correctAnswer = typeof o.correctAnswer === 'string' ? truncFleStr(o.correctAnswer, 500) : ''
    return {
      id: newFleStudyEventId(),
      at: atIso,
      type,
      sessionId,
      ok,
      testId,
      unitId,
      grammarTopic,
      testType,
      durationMs,
      question,
      userAnswer,
      correctAnswer,
    }
  }
  return null
}

function isValidYoutubeVideoId(v: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(v)
}

function offlineVideoPathForId(videoId: string, container: 'mp4' | 'webm' = 'mp4'): string {
  return join(ytOfflineVideoDir, `${videoId}.${container}`)
}

function offlineVideoPathsForId(videoId: string): string[] {
  return [offlineVideoPathForId(videoId, 'mp4'), offlineVideoPathForId(videoId, 'webm')]
}

function deleteFileIfExists(path: string) {
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    /* ignore */
  }
}

async function runYtDlpDownload(
  videoId: string,
  onProgress?: (stage: string, progress: number) => void,
): Promise<{
  filePath: string
  fileName: string
  bytes: number
  contentType: string
}> {
  mkdirSync(ytOfflineVideoDir, { recursive: true })
  for (const p of offlineVideoPathsForId(videoId)) deleteFileIfExists(p)
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  const outTpl = join(ytOfflineVideoDir, `${videoId}.%(ext)s`)

  const baseArgs = [
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--merge-output-format',
    'mp4',
    '--print',
    'after_move:filepath',
    '-o',
    outTpl,
    watchUrl,
  ]
  const variants = [
    ['--cookies-from-browser', 'chrome', '--extractor-args', 'youtube:player_client=android,web', '-f', 'bestvideo*+bestaudio/best'].concat(baseArgs),
    ['--cookies-from-browser', 'edge', '--extractor-args', 'youtube:player_client=android,web', '-f', 'bestvideo*+bestaudio/best'].concat(baseArgs),
    ['--extractor-args', 'youtube:player_client=android,web', '-f', 'bestvideo*+bestaudio/best'].concat(baseArgs),
    ['-f', 'bv*+ba/b'].concat(baseArgs),
  ]

  let lastTail = ''
  if (onProgress) onProgress('Подготовка загрузки', 2)
  for (const args of variants) {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const cp = spawn('yt-dlp', args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      cp.stdout.on('data', (d) => {
        const s = String(d || '')
        stdout += s
        const m = s.match(/(\d{1,3}(?:\.\d+)?)%/)
        if (m && onProgress) {
          const p = Math.max(0, Math.min(99, Math.round(Number(m[1]))))
          onProgress('Скачивание видео', p)
        }
      })
      cp.stderr.on('data', (d) => {
        const s = String(d || '')
        stderr += s
        const m = s.match(/(\d{1,3}(?:\.\d+)?)%/)
        if (m && onProgress) {
          const p = Math.max(0, Math.min(99, Math.round(Number(m[1]))))
          onProgress('Скачивание видео', p)
        }
      })
      cp.on('close', (code) => resolve({ code, stdout, stderr }))
      cp.on('error', (e) =>
        resolve({
          code: -1,
          stdout,
          stderr: `${stderr}\n${e instanceof Error ? e.message : String(e)}`,
        }),
      )
    })

    const outLines = result.stdout
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
    const printedPath = outLines.length ? outLines[outLines.length - 1] : ''
    const guessed = offlineVideoPathsForId(videoId).find((p) => existsSync(p)) || ''
    const filePath = printedPath && existsSync(printedPath) ? printedPath : guessed
    if (result.code === 0 && filePath && existsSync(filePath)) {
      if (onProgress) onProgress('Сохранение файла', 100)
      const st = statSync(filePath)
      const ext = extname(filePath).toLowerCase()
      const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4'
      return {
        filePath,
        fileName: `${videoId}${ext || '.mp4'}`,
        bytes: st.size,
        contentType,
      }
    }
    lastTail = (result.stderr || result.stdout || '').split(/\r?\n/).slice(-6).join(' ').trim()
  }

  throw new Error(lastTail || 'yt-dlp не смог скачать видео')
}

function shouldFallbackToYtdlCore(errMsg: string): boolean {
  const m = String(errMsg || '').toLowerCase()
  if (!m) return true
  return (
    m.includes('enoent') ||
    m.includes('not recognized as an internal or external command') ||
    m.includes('spawn yt-dlp') ||
    m.includes('permission denied')
  )
}

function pickYtDownloadCandidates(formats: ytdl.videoFormat[]): ytdl.videoFormat[] {
  const av = formats.filter((f) => !!f.hasAudio && !!f.hasVideo)
  const stable = av.filter((f) => !f.isHLS)
  const src = stable.length ? stable : av
  return src
    .slice()
    .sort((a, b) => {
      const cA = (a.container || '').toLowerCase() === 'mp4' ? 1 : 0
      const cB = (b.container || '').toLowerCase() === 'mp4' ? 1 : 0
      if (cA !== cB) return cB - cA
      const brA = Number(a.bitrate || 0)
      const brB = Number(b.bitrate || 0)
      if (brA !== brB) return brB - brA
      return Number(b.itag || 0) - Number(a.itag || 0)
    })
}

async function downloadYoutubeVideoToOffline(
  videoId: string,
  onProgress?: (stage: string, progress: number) => void,
): Promise<{
  filePath: string
  fileName: string
  bytes: number
  contentType: string
}> {
  let ytDlpErr: unknown = null
  try {
    return await runYtDlpDownload(videoId, onProgress)
  } catch (e) {
    ytDlpErr = e
    const ytDlpMsg = e instanceof Error ? e.message : String(e || '')
    if (!shouldFallbackToYtdlCore(ytDlpMsg)) {
      throw new Error(ytDlpMsg || 'yt-dlp не смог скачать видео')
    }
    // fallback to ytdl-core только если yt-dlp недоступен в системе
  }

  mkdirSync(ytOfflineVideoDir, { recursive: true })
  if (onProgress) onProgress('Получение данных о видео', 3)
  const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  const info = await ytdl.getInfo(videoUrl, {
    requestOptions: {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
      },
    },
  })
  const candidates = pickYtDownloadCandidates(info.formats).slice(0, 8)
  if (!candidates.length) throw new Error('Не найден формат видео с аудио для офлайн-загрузки')

  let lastErr: unknown = null
  for (const fmt of candidates) {
    const container = (fmt.container || '').toLowerCase() === 'webm' ? 'webm' : 'mp4'
    const finalPath = offlineVideoPathForId(videoId, container)
    const tmpPath = `${finalPath}.part`
    deleteFileIfExists(tmpPath)
    try {
      if (onProgress) onProgress('Скачивание видео', 5)
      const dl = ytdl.downloadFromInfo(info, {
        quality: fmt.itag,
        highWaterMark: 1 << 24,
      })
      if (onProgress) {
        dl.on('progress', (_chunkLen: number, downloaded: number, total: number) => {
          if (!total || total <= 0) return
          const raw = Math.round((downloaded / total) * 100)
          const p = Math.max(5, Math.min(99, raw))
          onProgress('Скачивание видео', p)
        })
      }
      await pipeline(dl, createWriteStream(tmpPath))
      for (const p of offlineVideoPathsForId(videoId)) {
        if (p !== finalPath) deleteFileIfExists(p)
      }
      deleteFileIfExists(finalPath)
      renameSync(tmpPath, finalPath)
      if (onProgress) onProgress('Сохранение файла', 100)
      const st = statSync(finalPath)
      const ext = extname(finalPath).toLowerCase()
      const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4'
      return {
        filePath: finalPath,
        fileName: `${videoId}${ext || '.mp4'}`,
        bytes: st.size,
        contentType,
      }
    } catch (e) {
      lastErr = e
      deleteFileIfExists(tmpPath)
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr || '')
  const ytDlpMsg = ytDlpErr instanceof Error ? ytDlpErr.message : String(ytDlpErr || '')
  const joinedMsg = [ytDlpMsg, msg].filter(Boolean).join(' | ')
  if (/playable format|payable format|no such format/i.test(joinedMsg)) {
    throw new Error(
      'YouTube не отдал подходящий формат для скачивания. Обычно помогает вход в YouTube в браузере (Chrome/Edge) и повторная попытка.',
    )
  }
  if (/video unavailable|private video|members-only|sign in|age-restricted|premiere/i.test(joinedMsg)) {
    throw new Error(
      'YouTube недоступен из текущей сети/профиля (Video unavailable). Проверьте доступ к youtube.com, VPN/прокси и ограничения по региону/возрасту.',
    )
  }
  throw new Error(joinedMsg || 'Не удалось скачать видео с YouTube')
}

type PortuprepApiOpts = {
  openaiKey?: string
  elevenLabsApiKey?: string
  /** Голос ElevenLabs (voice_id); по умолчанию — Adam (мужской, мультиязычный). Переопределяется ELEVENLABS_VOICE_ID в .env */
  elevenLabsVoiceId?: string
  /** Путь к файлу большого П–Р словаря (.pdf/.docx). */
  bigDictSourcePath?: string
  /** Набор источников для вкладки «Большой словарь». */
  bigDictSources?: Record<string, string>
  /** Путь к внешнему HTML-файлу программы CELPE. */
  celpeProgramSourcePath?: string
  /** Путь к внешнему HTML-файлу теста уровня. */
  nivelTestSourcePath?: string
}

/** Префикс Adam — мужской пресет ElevenLabs, хорошо подходит к eleven_multilingual_v2 + language_code pt/ru. */
const ELEVENLABS_DEFAULT_VOICE_ID_MALE = 'pNInz6obpgDQGcFmaJgB'

function portuprepApiPlugin(api: PortuprepApiOpts) {
  const openaiKey = api.openaiKey
  const elevenLabsApiKey = api.elevenLabsApiKey
  const elevenLabsVoiceId =
    (api.elevenLabsVoiceId && api.elevenLabsVoiceId.trim()) || ELEVENLABS_DEFAULT_VOICE_ID_MALE
  const bigDictSourcePath = api.bigDictSourcePath?.trim()
  const bigDictSources = api.bigDictSources
  const celpeProgramSourcePath = api.celpeProgramSourcePath?.trim()
  const nivelTestSourcePath = api.nivelTestSourcePath?.trim()
  type YtOfflineDownloadJob = {
    videoId: string
    status: 'idle' | 'downloading' | 'done' | 'error'
    progress: number
    stage: string
    error?: string
    fileName?: string
    bytes?: number
    contentType?: string
    startedAt?: number
    endedAt?: number
    updatedAt: number
  }
  const ytOfflineDownloadJobs = new Map<string, YtOfflineDownloadJob>()
  const setYtJob = (videoId: string, patch: Partial<YtOfflineDownloadJob>) => {
    const now = Date.now()
    const prev =
      ytOfflineDownloadJobs.get(videoId) || {
        videoId,
        status: 'idle' as const,
        progress: 0,
        stage: '',
        updatedAt: now,
      }
    const next: YtOfflineDownloadJob = {
      ...prev,
      ...patch,
      videoId,
      updatedAt: now,
    }
    ytOfflineDownloadJobs.set(videoId, next)
    return next
  }
  const getYtJob = (videoId: string): YtOfflineDownloadJob => {
    const job = ytOfflineDownloadJobs.get(videoId)
    if (job) return job
    const filePath = offlineVideoPathsForId(videoId).find((p) => existsSync(p)) || ''
    if (filePath && existsSync(filePath)) {
      const st = statSync(filePath)
      const ext = extname(filePath).toLowerCase()
      return {
        videoId,
        status: 'done',
        progress: 100,
        stage: 'Готово',
        fileName: `${videoId}${ext || '.mp4'}`,
        bytes: st.size,
        contentType: ext === '.webm' ? 'video/webm' : 'video/mp4',
        updatedAt: Date.now(),
      }
    }
    return {
      videoId,
      status: 'idle',
      progress: 0,
      stage: 'Ожидание',
      updatedAt: Date.now(),
    }
  }

  const vocabularyHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/api/vocabulary')) {
      next()
      return
    }

    void (async () => {
      try {
        if (req.method === 'GET') {
          if (!existsSync(vocabularyFile)) {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ words: [] }))
            return
          }
          let parsed: { words?: unknown }
          try {
            parsed = JSON.parse(readFileSync(vocabularyFile, 'utf8')) as { words?: unknown }
          } catch {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ words: [] }))
            return
          }
          const words = Array.isArray(parsed.words) ? parsed.words : []
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ words }))
          return
        }

        if (req.method === 'PUT' || req.method === 'POST') {
          const rawBody = await readJsonBody(req)
          let body: { words?: unknown }
          try {
            body = JSON.parse(rawBody) as { words?: unknown }
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'Invalid JSON body' }))
            return
          }
          if (!Array.isArray(body.words)) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'Ожидается объект { words: [...] }' }))
            return
          }
          mkdirSync(vocabularyDir, { recursive: true })
          writeFileSync(vocabularyFile, JSON.stringify({ words: body.words }, null, 2), 'utf8')
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true }))
          return
        }

        res.statusCode = 405
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Allow', 'GET, PUT, POST')
        res.end(JSON.stringify({ error: 'Method not allowed' }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const celpeProgramPageHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/celpe-program')) {
      next()
      return
    }
    try {
      const src = celpeProgramSourcePath || ''
      if (!src || !existsSync(src)) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          `<html><body style="font-family:system-ui;padding:24px">
            <h2>Файл программы не найден</h2>
            <p>Ожидается файл: <code>${src || 'не задан путь'}</code></p>
          </body></html>`,
        )
        return
      }
      const html = readFileSync(src, 'utf8')
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(html)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<html><body style="font-family:system-ui;padding:24px"><h2>Ошибка загрузки программы</h2><p>${msg}</p></body></html>`)
    }
  }

  const nivelTestPageHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/nivel-test')) {
      next()
      return
    }
    try {
      const src = nivelTestSourcePath || ''
      if (!src || !existsSync(src)) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          `<html><body style="font-family:system-ui;padding:24px">
            <h2>Файл теста уровня не найден</h2>
            <p>Ожидается файл: <code>${src || 'не задан путь'}</code></p>
          </body></html>`,
        )
        return
      }
      const html = readFileSync(src, 'utf8')
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(html)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      res.statusCode = 500
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<html><body style="font-family:system-ui;padding:24px"><h2>Ошибка загрузки теста</h2><p>${msg}</p></body></html>`)
    }
  }

  const vocabGenerateImageHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/api/vocab-generate-image')) {
      next()
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Allow', 'POST')
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }
    if (!openaiKey) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'OPENAI_API_KEY не задан (нужен для генерации картинок)' }))
      return
    }

    void (async () => {
      try {
        const rawBody = await readJsonBody(req)
        let body: { id?: unknown; word?: unknown; translation?: unknown; example?: unknown }
        try {
          body = JSON.parse(rawBody || '{}') as typeof body
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }
        const idRaw = body.id
        const idNum =
          typeof idRaw === 'number' && Number.isInteger(idRaw) && idRaw > 0
            ? idRaw
            : typeof idRaw === 'string' && /^\d+$/.test(idRaw.trim())
              ? parseInt(idRaw.trim(), 10)
              : NaN
        if (!Number.isInteger(idNum) || idNum <= 0) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Ожидается поле id (положительное целое число)' }))
          return
        }

        let word = typeof body.word === 'string' ? body.word.trim() : ''
        let translation = typeof body.translation === 'string' ? body.translation.trim() : ''
        let example = typeof body.example === 'string' ? body.example.trim() : ''

        if (!word || !translation) {
          if (existsSync(vocabularyFile)) {
            try {
              const parsed = JSON.parse(readFileSync(vocabularyFile, 'utf8')) as {
                words?: Array<{ id?: number; word?: string; translation?: string; example?: string }>
              }
              const arr = Array.isArray(parsed.words) ? parsed.words : []
              const found = arr.find((w) => Number(w.id) === idNum)
              if (found) {
                if (!word) word = String(found.word || '').trim()
                if (!translation) translation = String(found.translation || '').trim()
                if (!example) example = String(found.example || '').trim()
              }
            } catch {
              /* ignore */
            }
          }
        }

        if (!word || !translation) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              error: 'Нужны слово и перевод (в теле запроса или в сохранённом словаре)',
            }),
          )
          return
        }

        const promptParts = [
          'Минималистичная иллюстрация для карточки запоминания португальского слова.',
          `Португальское слово: ${word}.`,
          `Смысл (русский): ${translation}.`,
        ]
        if (example) promptParts.push(`Контекст / пример: ${example.slice(0, 280)}.`)
        promptParts.push('Без текста на картинке. Простой чистый стиль, понятная визуальная метафора.')

        const oaRes = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-image-1-mini',
            prompt: promptParts.join(' '),
            size: '1024x1024',
            quality: 'low',
            output_format: 'png',
          }),
        })

        const raw = (await oaRes.json()) as {
          error?: { message?: string }
          data?: Array<{ b64_json?: string }>
        }
        if (!oaRes.ok) {
          throw new Error(raw.error?.message || `OpenAI HTTP ${oaRes.status}`)
        }
        const b64 = raw.data?.[0]?.b64_json
        if (!b64 || typeof b64 !== 'string') {
          throw new Error('Ответ OpenAI без b64_json')
        }

        let buf: Buffer
        try {
          buf = Buffer.from(b64, 'base64')
        } catch {
          throw new Error('Не удалось декодировать изображение')
        }
        if (!buf.length) throw new Error('Пустое изображение')

        mkdirSync(vocabImagesDir, { recursive: true })
        const fileName = `${idNum}.png`
        const filePath = join(vocabImagesDir, fileName)
        writeFileSync(filePath, buf)

        const v = Date.now()
        const path = `/vocab-images/${fileName}`
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ path, url: `${path}?v=${v}` }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const fleStudyLogHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith('/api/fle-study-log')) {
      next()
      return
    }

    void (async () => {
      try {
        if (req.method === 'GET') {
          const log = readFleStudyLog()
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(log))
          return
        }

        if (req.method === 'DELETE') {
          writeFleStudyLog({ version: 1, events: [] })
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true }))
          return
        }

        if (req.method === 'POST') {
          const rawBody = await readJsonBody(req)
          let body: { events?: unknown; removeIds?: unknown }
          try {
            body = JSON.parse(rawBody) as { events?: unknown; removeIds?: unknown }
          } catch {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: 'Invalid JSON body' }))
            return
          }

          if (Array.isArray(body.removeIds) && body.removeIds.length) {
            const idSet = new Set<string>()
            for (const x of body.removeIds) {
              if (typeof x === 'string' && x.trim()) idSet.add(truncFleStr(x.trim(), 128))
            }
            if (idSet.size === 0) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ error: 'removeIds: нет валидных id' }))
              return
            }
            const log = readFleStudyLog()
            const before = log.events.length
            log.events = log.events.filter((ev) => {
              const id =
                ev && typeof ev === 'object' && typeof (ev as Record<string, unknown>).id === 'string'
                  ? ((ev as Record<string, unknown>).id as string)
                  : ''
              return !idSet.has(id)
            })
            writeFleStudyLog(log)
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: true, removed: before - log.events.length }))
            return
          }

          if (!Array.isArray(body.events)) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(
              JSON.stringify({ error: 'Ожидается { events: [...] } или { removeIds: [...] }' }),
            )
            return
          }
          const log = readFleStudyLog()
          const at = new Date().toISOString()
          let added = 0
          for (const ev of body.events) {
            const norm = normalizeFleStudyEvent(ev, at)
            if (norm) {
              log.events.push(norm)
              added++
            }
          }
          if (log.events.length > FLE_STUDY_LOG_MAX_EVENTS) {
            log.events = log.events.slice(-FLE_STUDY_LOG_MAX_EVENTS)
          }
          writeFleStudyLog(log)
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, added }))
          return
        }

        res.statusCode = 405
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Allow', 'GET, POST, DELETE')
        res.end(JSON.stringify({ error: 'Method not allowed' }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  /** Заголовок ролика для группировки словаря (oEmbed с сервера — без CORS в браузере). */
  const youtubeOembedHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/youtube-oembed')) {
      next()
      return
    }

    void (async () => {
      try {
        const u = new URL(req.url || '', 'http://localhost')
        const v = u.searchParams.get('v')
        if (!v || !/^[A-Za-z0-9_-]{11}$/.test(v)) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Нужен v (11 символов id видео)' }))
          return
        }
        const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`
        const oe = await fetch(
          `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`,
        )
        if (!oe.ok) {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ title: '' }))
          return
        }
        const j = (await oe.json()) as { title?: string }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ title: typeof j.title === 'string' ? j.title : '' }))
      } catch {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ title: '' }))
      }
    })()
  }

  const youtubeOfflineDownloadHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/youtube-offline-download')) {
      next()
      return
    }
    void (async () => {
      try {
        const rawBody = await readJsonBody(req)
        let body: { v?: string }
        try {
          body = JSON.parse(rawBody || '{}') as { v?: string }
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }
        const v = typeof body.v === 'string' ? body.v.trim() : ''
        if (!isValidYoutubeVideoId(v)) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Нужен параметр v (11 символов id видео)' }))
          return
        }
        const current = ytOfflineDownloadJobs.get(v)
        if (current && current.status === 'downloading') {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, started: false, videoId: v, status: current.status }))
          return
        }
        setYtJob(v, {
          status: 'downloading',
          progress: 1,
          stage: 'Подготовка загрузки',
          error: '',
          startedAt: Date.now(),
        })
        void (async () => {
          try {
            const out = await downloadYoutubeVideoToOffline(v, (stage, progress) => {
              setYtJob(v, {
                status: 'downloading',
                stage: stage || 'Скачивание видео',
                progress: Math.max(0, Math.min(100, Number(progress || 0))),
              })
            })
            setYtJob(v, {
              status: 'done',
              progress: 100,
              stage: 'Готово',
              fileName: out.fileName,
              bytes: out.bytes,
              contentType: out.contentType,
              endedAt: Date.now(),
              error: '',
            })
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            setYtJob(v, {
              status: 'error',
              progress: 0,
              stage: 'Ошибка',
              error: `Не удалось скачать видео: ${msg}`,
              endedAt: Date.now(),
            })
          }
        })()
        res.statusCode = 202
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, started: true, videoId: v, status: 'downloading' }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: `Не удалось скачать видео: ${msg}` }))
      }
    })()
  }

  const youtubeOfflineDownloadStatusHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/youtube-offline-download-status')) {
      next()
      return
    }
    void (async () => {
      try {
        const u = new URL(req.url || '', 'http://localhost')
        const v = (u.searchParams.get('v') || '').trim()
        if (!isValidYoutubeVideoId(v)) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Нужен параметр v (11 символов id видео)' }))
          return
        }
        const st = getYtJob(v)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(st))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const youtubeOfflineVideoHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/youtube-offline-video')) {
      next()
      return
    }
    void (async () => {
      try {
        const u = new URL(req.url || '', 'http://localhost')
        const v = (u.searchParams.get('v') || '').trim()
        if (!isValidYoutubeVideoId(v)) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Нужен параметр v (11 символов id видео)' }))
          return
        }
        const filePath = offlineVideoPathsForId(v).find((p) => existsSync(p)) || ''
        if (!existsSync(filePath)) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Офлайн-видео не найдено. Скачайте его кнопкой «Скачать видео».' }))
          return
        }
        const st = statSync(filePath)
        const total = st.size
        const contentType = extname(filePath).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4'
        const range = req.headers.range
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/i.exec(range)
          if (!m) {
            res.statusCode = 416
            res.setHeader('Content-Range', `bytes */${total}`)
            res.end()
            return
          }
          let start = m[1] ? parseInt(m[1], 10) : 0
          let end = m[2] ? parseInt(m[2], 10) : total - 1
          if (!Number.isFinite(start) || start < 0) start = 0
          if (!Number.isFinite(end) || end >= total) end = total - 1
          if (start > end || start >= total) {
            res.statusCode = 416
            res.setHeader('Content-Range', `bytes */${total}`)
            res.end()
            return
          }
          res.statusCode = 206
          res.setHeader('Content-Type', contentType)
          res.setHeader('Accept-Ranges', 'bytes')
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
          res.setHeader('Content-Length', String(end - start + 1))
          createReadStream(filePath, { start, end }).pipe(res)
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', contentType)
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Length', String(total))
        createReadStream(filePath).pipe(res)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const youtubeHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/youtube-transcript')) {
      next()
      return
    }

    void (async () => {
      try {
        const u = new URL(req.url || '', 'http://localhost')
        const v = u.searchParams.get('v')
        const lang = u.searchParams.get('lang') || undefined
        if (!v) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Укажите параметр v (id видео)' }))
          return
        }

        const transcriptTimeoutMs = 45_000
        const segments = await Promise.race([
          fetchYoutubeTranscriptRobust(v, lang ? { lang } : {}),
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    'Таймаут загрузки субтитров (45 с). Повторите запрос или смените язык в списке.',
                  ),
                ),
              transcriptTimeoutMs,
            )
          }),
        ])

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ segments }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const translateHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/transcript-translate')) {
      next()
      return
    }

    void (async () => {
      try {
        if (!openaiKey) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              error:
                'OPENAI_API_KEY is not set. Create tutor-app/.env with OPENAI_API_KEY=... (e.g. copy from E:\\GIT\\TSC app\\.env) and restart npm run dev.',
            }),
          )
          return
        }

        const rawBody = await readJsonBody(req)
        let body: { words?: string[] }
        try {
          body = JSON.parse(rawBody) as { words?: string[] }
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }

        const words = Array.isArray(body.words) ? body.words.map((w) => String(w).toLowerCase().trim()).filter(Boolean) : []
        const unique = [...new Set(words)].slice(0, 2000)
        if (!unique.length) {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ gloss: {} }))
          return
        }

        const gloss = await buildGlossWithGapPasses(unique, openaiKey)

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ gloss }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const bookTranslateHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/book-translate')) {
      next()
      return
    }

    void (async () => {
      try {
        if (!openaiKey) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              error:
                'OPENAI_API_KEY is not set. Для перевода через модель добавьте ключ в tutor-app/.env или используйте кнопку — сработает бесплатный MyMemory (ограничен по длине).',
            }),
          )
          return
        }

        const rawBody = await readJsonBody(req)
        let body: { text?: string }
        try {
          body = JSON.parse(rawBody) as { text?: string }
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }

        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text.length < 2) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Пустой текст' }))
          return
        }
        if (text.length > 14_000) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Фрагмент слишком длинный (макс. ~14000 символов)' }))
          return
        }

        const translation = await openaiTranslateBookPassage(text, openaiKey)
        if (!translation) {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Пустой ответ модели' }))
          return
        }

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ translation }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const explainHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/transcript-explain')) {
      next()
      return
    }

    void (async () => {
      try {
        if (!openaiKey) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              error:
                'OPENAI_API_KEY is not set. Добавьте ключ в tutor-app/.env и перезапустите dev-сервер.',
            }),
          )
          return
        }

        const rawBody = await readJsonBody(req)
        let body: { text?: string }
        try {
          body = JSON.parse(rawBody) as { text?: string }
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }

        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text.length < 2) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Выделите непустой фрагмент в субтитрах' }))
          return
        }
        if (text.length > 3000) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Фрагмент слишком длинный (макс. ~3000 символов)' }))
          return
        }

        const explanation = await openaiExplainPortugueseConstruction(text, openaiKey)
        if (!explanation) {
          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Пустой ответ модели' }))
          return
        }

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ explanation }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const vocabStoryHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/vocab-story')) {
      next()
      return
    }

    void (async () => {
      try {
        if (!openaiKey) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              error:
                'OPENAI_API_KEY is not set. Добавьте ключ в tutor-app/.env и перезапустите dev-сервер.',
            }),
          )
          return
        }

        const rawBody = await readJsonBody(req)
        let body: { items?: unknown; style?: string; length?: string; hint?: string }
        try {
          body = JSON.parse(rawBody) as { items?: unknown; style?: string; length?: string; hint?: string }
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }

        const rawItems = Array.isArray(body.items) ? body.items : []
        const items: { word: string; translation: string }[] = []
        for (const it of rawItems.slice(0, 25)) {
          if (!it || typeof it !== 'object' || Array.isArray(it)) continue
          const rec = it as Record<string, unknown>
          const word = typeof rec.word === 'string' ? rec.word.trim() : ''
          const translation = typeof rec.translation === 'string' ? rec.translation.trim() : ''
          if (word.length < 1 || word.length > 120) continue
          items.push({ word, translation: translation.slice(0, 220) })
        }
        if (items.length < 1) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Передайте 1–25 слов (items: [{ word, translation }])' }))
          return
        }

        const style = typeof body.style === 'string' ? body.style.trim() : 'story'
        const length = typeof body.length === 'string' ? body.length.trim() : 'medium'
        const hint = typeof body.hint === 'string' ? body.hint : ''

        const out = await openaiVocabStory(items, style, length, hint, openaiKey)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ portuguese: out.portuguese, russian: out.russian }))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const vocabClassifyHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/vocab-classify')) {
      next()
      return
    }

    void (async () => {
      try {
        if (!openaiKey) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              error:
                'OPENAI_API_KEY is not set. Добавьте ключ в tutor-app/.env и перезапустите dev-сервер.',
            }),
          )
          return
        }

        const rawBody = await readJsonBody(req)
        let body: { word?: string; translation?: string }
        try {
          body = JSON.parse(rawBody) as { word?: string; translation?: string }
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }

        const word = typeof body.word === 'string' ? body.word.trim() : ''
        if (word.length < 1) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Укажите слово (PT)' }))
          return
        }
        if (word.length > 500) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Слишком длинная строка' }))
          return
        }

        const translation = typeof body.translation === 'string' ? body.translation.trim() : undefined
        const out = await openaiClassifyVocabPortuguese(word, translation, openaiKey)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(out))
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const elevenLabsTtsHandler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/api/elevenlabs-tts')) {
      next()
      return
    }

    void (async () => {
      try {
        if (!elevenLabsApiKey) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(
            JSON.stringify({
              error:
                'ELEVENLABS_API_KEY не задан. Добавьте в tutor-app/.env: ELEVENLABS_API_KEY=... и при необходимости ELEVENLABS_VOICE_ID=... Перезапустите dev-сервер.',
            }),
          )
          return
        }

        const rawBody = await readJsonBody(req)
        let body: { text?: string; language_code?: string }
        try {
          body = JSON.parse(rawBody) as { text?: string; language_code?: string }
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Invalid JSON body' }))
          return
        }

        const text = typeof body.text === 'string' ? body.text.trim().replace(/\s+/g, ' ') : ''
        if (!text.length) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Пустой текст' }))
          return
        }
        if (text.length > 2500) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Текст слишком длинный (макс. 2500 символов)' }))
          return
        }

        let languageCode: string | undefined
        const lcRaw = typeof body.language_code === 'string' ? body.language_code.trim().toLowerCase() : ''
        if (lcRaw === 'pt' || lcRaw === 'ru') languageCode = lcRaw
        const elPayload: Record<string, string> = {
          text,
          model_id: 'eleven_multilingual_v2',
        }
        if (languageCode) elPayload.language_code = languageCode

        const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenLabsVoiceId)}`
        const elRes = await fetch(url, {
          method: 'POST',
          headers: {
            'xi-api-key': elevenLabsApiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify(elPayload),
        })

        if (!elRes.ok) {
          let errMsg = `ElevenLabs HTTP ${elRes.status}`
          try {
            const errJson = (await elRes.json()) as {
              detail?: string | { message?: string }
            }
            if (typeof errJson.detail === 'string') errMsg = errJson.detail
            else if (errJson.detail && typeof errJson.detail === 'object' && errJson.detail.message) {
              errMsg = errJson.detail.message
            }
          } catch {
            /* ignore */
          }
          res.statusCode = elRes.status >= 400 && elRes.status < 600 ? elRes.status : 502
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: errMsg }))
          return
        }

        const buf = Buffer.from(await elRes.arrayBuffer())
        res.statusCode = 200
        res.setHeader('Content-Type', 'audio/mpeg')
        res.setHeader('Cache-Control', 'private, max-age=300')
        res.end(buf)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: msg }))
      }
    })()
  }

  const healthHandler = createHealthHandler()
  const difficultyApiHandler = createDifficultyApiHandler(difficultyAnalysesFile)
  const bigDictApiHandler = createBigDictApiHandler({
    sources: bigDictSources,
    sourcePath: bigDictSourcePath,
    dataDir,
    openaiKey,
  })

  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(celpeProgramPageHandler)
    server.middlewares.use(nivelTestPageHandler)
    server.middlewares.use(healthHandler)
    server.middlewares.use(difficultyApiHandler)
    server.middlewares.use(bigDictApiHandler)
    server.middlewares.use(vocabularyHandler)
    server.middlewares.use(vocabGenerateImageHandler)
    server.middlewares.use(fleStudyLogHandler)
    server.middlewares.use(youtubeOembedHandler)
    server.middlewares.use(youtubeOfflineDownloadHandler)
    server.middlewares.use(youtubeOfflineDownloadStatusHandler)
    server.middlewares.use(youtubeOfflineVideoHandler)
    server.middlewares.use(youtubeHandler)
    server.middlewares.use(translateHandler)
    server.middlewares.use(bookTranslateHandler)
    server.middlewares.use(explainHandler)
    server.middlewares.use(vocabStoryHandler)
    server.middlewares.use(vocabClassifyHandler)
    server.middlewares.use(elevenLabsTtsHandler)
  }

  return {
    name: 'portuprep-api',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}

/** Резервный разбор .env, если нужно обойти нюансы loadEnv. Порядок файлов как у Vite — последний выигрывает. */
function readOpenAiKeyFromDotEnvFiles(mode: string): string | undefined {
  const files = [
    join(viteConfigDir, '.env'),
    join(viteConfigDir, '.env.local'),
    join(viteConfigDir, `.env.${mode}`),
    join(viteConfigDir, `.env.${mode}.local`),
  ]
  let found: string | undefined
  for (const fp of files) {
    if (!existsSync(fp)) continue
    try {
      const text = readFileSync(fp, 'utf8').replace(/^\uFEFF/, '')
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const m = t.match(/^OPENAI_API_KEY\s*=\s*(.*)$/)
        if (!m) continue
        const raw = m[1].trim().replace(/^['"]|['"]$/g, '')
        if (raw) found = raw
      }
    } catch {
      /* ignore */
    }
  }
  return found
}

function resolveOpenAiKey(mode: string): string | undefined {
  // Префикс "OPENAI_" — подтягивает только переменные OPENAI_* (в т.ч. OPENAI_API_KEY).
  const fromVite = loadEnv(mode, viteConfigDir, 'OPENAI_').OPENAI_API_KEY
  const raw = (
    fromVite ||
    readOpenAiKeyFromDotEnvFiles(mode) ||
    process.env.OPENAI_API_KEY ||
    ''
  )
    .trim()
    .replace(/^['"]|['"]$/g, '')
  return raw || undefined
}

function resolveElevenLabsApiKey(mode: string): string | undefined {
  const fromVite = loadEnv(mode, viteConfigDir, 'ELEVENLABS_').ELEVENLABS_API_KEY
  const raw = (fromVite || process.env.ELEVENLABS_API_KEY || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  return raw || undefined
}

function resolveElevenLabsVoiceId(mode: string): string | undefined {
  const fromVite = loadEnv(mode, viteConfigDir, 'ELEVENLABS_').ELEVENLABS_VOICE_ID
  const raw = (fromVite || process.env.ELEVENLABS_VOICE_ID || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  return raw || undefined
}

/** Путь к файлу «Большой португальско-русский словарь» для локального RAG-поиска. */
function resolveBigDictSource(mode: string): string | undefined {
  const env = loadEnv(mode, viteConfigDir, '')
  const fromEnv = env.BIG_PT_RU_DICT_FILE || process.env.BIG_PT_RU_DICT_FILE
  const legacyPdf = env.BIG_PT_RU_DICT_PDF || process.env.BIG_PT_RU_DICT_PDF
  const defaultDocx = join(viteConfigDir, '..', 'Dictionary', 'Dictionary.docx')
  const raw = (fromEnv || (existsSync(defaultDocx) ? defaultDocx : '') || legacyPdf || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  return raw || undefined
}

function resolveBigDictSources(mode: string): Record<string, string> {
  const env = loadEnv(mode, viteConfigDir, '')
  const out: Record<string, string> = {}
  const main = resolveBigDictSource(mode)
  if (main) out.main = main

  const tolkovyFromEnv = env.BIG_TOLKOVY_DICT_FILE || process.env.BIG_TOLKOVY_DICT_FILE
  const tolkovyDefaultPdf = join(viteConfigDir, '..', 'Dictionary', 'Tolkovy.pdf')
  const tolkovyRaw = (tolkovyFromEnv || (existsSync(tolkovyDefaultPdf) ? tolkovyDefaultPdf : '') || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  if (tolkovyRaw) out.tolkovy = tolkovyRaw

  return out
}

function resolveCelpeProgramSource(mode: string): string | undefined {
  const env = loadEnv(mode, viteConfigDir, '')
  const fromEnv = env.CELPE_PROGRAM_FILE || process.env.CELPE_PROGRAM_FILE
  const defaultPath = 'C:/Users/lenovo/Downloads/portuprep-celpe (2).html'
  const raw = (fromEnv || defaultPath || '').trim().replace(/^['"]|['"]$/g, '')
  return raw || undefined
}

function resolveNivelTestSource(mode: string): string | undefined {
  const env = loadEnv(mode, viteConfigDir, '')
  const fromEnv = env.NIVEL_TEST_FILE || process.env.NIVEL_TEST_FILE
  const defaultPath = 'C:/Users/lenovo/Downloads/nivel-test.html'
  const raw = (fromEnv || defaultPath || '').trim().replace(/^['"]|['"]$/g, '')
  return raw || undefined
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  return {
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      // nginx proxy_pass передаёт Host продакшен-домена — разрешаем для /api/
      allowedHosts: ['gentechnet.com', 'www.gentechnet.com', 'localhost', '127.0.0.1'],
    },
    plugins: [
      react(),
      portuprepApiPlugin({
        openaiKey: resolveOpenAiKey(mode),
        elevenLabsApiKey: resolveElevenLabsApiKey(mode),
        elevenLabsVoiceId: resolveElevenLabsVoiceId(mode),
        bigDictSourcePath: resolveBigDictSource(mode),
        bigDictSources: resolveBigDictSources(mode),
        celpeProgramSourcePath: resolveCelpeProgramSource(mode),
        nivelTestSourcePath: resolveNivelTestSource(mode),
      }),
    ],
  }
})
