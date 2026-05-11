/**
 * Fallbacks when youtube-transcript reports "Transcript is disabled" while captions exist in other InnerTube clients or on the embed player page.
 * Parsing helpers mirror youtube-transcript (MIT) behaviour.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { TranscriptConfig, TranscriptResponse } from 'youtube-transcript'

/** tutor-app/ root — для загрузки `youtube-transcript` ESM (как в vite.config.ts). */
const tutorAppRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const ytEsmHref = pathToFileURL(
  join(tutorAppRoot, 'node_modules/youtube-transcript/dist/youtube-transcript.esm.js'),
).href

type YoutubeTranscriptCtor = (typeof import('youtube-transcript'))['YoutubeTranscript']

let ytClassPromise: Promise<YoutubeTranscriptCtor> | null = null
function loadYoutubeTranscriptClass(): Promise<YoutubeTranscriptCtor> {
  if (!ytClassPromise) {
    ytClassPromise = import(ytEsmHref).then((m: { YoutubeTranscript: YoutubeTranscriptCtor }) => m.YoutubeTranscript)
  }
  return ytClassPromise
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36,gzip(gfe)'
const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g
const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'

/** Bump periodically if WEB stops returning captions (see yt-dlp INNERTUBE_CLIENTS). */
const EXTRA_INNERTUBE_CLIENTS: ReadonlyArray<{
  client: Record<string, string | undefined>
  userAgent: string
  thirdParty?: { embedUrl: string }
}> = [
  {
    client: { clientName: 'WEB', clientVersion: '2.20260114.08.00', hl: 'en' },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36,gzip(gfe)',
  },
  {
    client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20260115.01.00', hl: 'en' },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36,gzip(gfe)',
    thirdParty: { embedUrl: 'https://www.youtube.com' },
  },
  {
    client: { clientName: 'MWEB', clientVersion: '2.20260115.01.00', hl: 'en' },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36,gzip(gfe)',
  },
]

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
}

function parseTranscriptXml(xml: string, lang: string): TranscriptResponse[] {
  const results: TranscriptResponse[] = []
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g
  let match: RegExpExecArray | null
  while ((match = pRegex.exec(xml)) !== null) {
    const startMs = parseInt(match[1], 10)
    const durMs = parseInt(match[2], 10)
    const inner = match[3]
    let text = ''
    const sRegex = /<s[^>]*>([^<]*)<\/s>/g
    let sMatch: RegExpExecArray | null
    while ((sMatch = sRegex.exec(inner)) !== null) {
      text += sMatch[1]
    }
    if (!text) {
      text = inner.replace(/<[^>]+>/g, '')
    }
    text = decodeEntities(text).trim()
    if (text) {
      results.push({
        text,
        duration: durMs,
        offset: startMs,
        lang,
      })
    }
  }
  if (results.length > 0) return results

  const classicResults = [...xml.matchAll(RE_XML_TRANSCRIPT)]
  return classicResults.map((result) => ({
    text: decodeEntities(result[3]),
    duration: parseFloat(result[2]),
    offset: parseFloat(result[1]),
    lang,
  }))
}

function parseInlineJson(html: string, globalName: string): Record<string, unknown> | null {
  const startToken = `var ${globalName} = `
  const startIndex = html.indexOf(startToken)
  if (startIndex === -1) return null
  const jsonStart = startIndex + startToken.length
  let depth = 0
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(jsonStart, i + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

type CaptionTrack = { languageCode?: string; baseUrl?: string }

async function fetchTranscriptFromTracks(
  captionTracks: CaptionTrack[],
  _videoId: string,
  lang: string | undefined,
  fetchFn: typeof fetch,
): Promise<TranscriptResponse[]> {
  if (!captionTracks.length) return []

  let track: CaptionTrack | undefined
  if (lang) {
    track = captionTracks.find((t) => t.languageCode === lang) ?? captionTracks[0]
  } else {
    track = captionTracks[0]
  }
  const transcriptURL = track?.baseUrl
  if (!transcriptURL) return []

  try {
    const captionUrl = new URL(transcriptURL)
    if (!captionUrl.hostname.endsWith('.youtube.com')) return []
  } catch {
    return []
  }

  const transcriptResponse = await fetchFn(transcriptURL, {
    headers: {
      ...(lang && { 'Accept-Language': lang }),
      'User-Agent': USER_AGENT,
    },
  })
  if (!transcriptResponse.ok) return []

  const transcriptBody = await transcriptResponse.text()
  const resolvedLang = lang ?? captionTracks[0]?.languageCode ?? 'und'
  return parseTranscriptXml(transcriptBody, resolvedLang)
}

async function fetchViaExtraInnertube(
  videoId: string,
  lang: string | undefined,
  fetchFn: typeof fetch,
): Promise<TranscriptResponse[]> {
  for (const { client, userAgent, thirdParty } of EXTRA_INNERTUBE_CLIENTS) {
    try {
      const context: Record<string, unknown> = { client }
      if (thirdParty) {
        context.thirdParty = thirdParty
      }
      const resp = await fetchFn(INNERTUBE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
        },
        body: JSON.stringify({ context, videoId }),
      })
      if (!resp.ok) continue
      const data = (await resp.json()) as {
        captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } }
      }
      const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (!Array.isArray(captionTracks) || captionTracks.length === 0) continue

      const segments = await fetchTranscriptFromTracks(captionTracks, videoId, lang, fetchFn)
      if (segments.length > 0) return segments
    } catch {
      continue
    }
  }
  return []
}

async function fetchViaEmbedPage(
  videoId: string,
  lang: string | undefined,
  fetchFn: typeof fetch,
): Promise<TranscriptResponse[]> {
  const videoPageResponse = await fetchFn(`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?hl=en`, {
    headers: {
      ...(lang && { 'Accept-Language': lang }),
      'User-Agent': USER_AGENT,
    },
  })
  const videoPageBody = await videoPageResponse.text()

  const playerResponse = parseInlineJson(videoPageBody, 'ytInitialPlayerResponse') as
    | {
        captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } }
      }
    | null
  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) return []

  return fetchTranscriptFromTracks(captionTracks, videoId, lang, fetchFn)
}

/**
 * Same as YoutubeTranscript.fetchTranscript, plus InnerTube WEB/MWEB/embed fallbacks when the stock path falsely reports captions disabled.
 */
export async function fetchYoutubeTranscriptRobust(
  videoId: string,
  config?: TranscriptConfig,
): Promise<TranscriptResponse[]> {
  const YoutubeTranscript = await loadYoutubeTranscriptClass()
  const lang = config?.lang
  const fetchFn = config?.fetch ?? fetch

  let lastErr: unknown

  try {
    return await YoutubeTranscript.fetchTranscript(videoId, lang ? { lang, fetch: fetchFn } : { fetch: fetchFn })
  } catch (e) {
    lastErr = e
  }

  try {
    return await YoutubeTranscript.fetchTranscript(videoId, { fetch: fetchFn })
  } catch (e) {
    lastErr = e
  }

  try {
    const segments = await fetchViaExtraInnertube(videoId, lang, fetchFn)
    if (segments.length > 0) return segments
  } catch (e) {
    lastErr = e
  }

  try {
    const segments = await fetchViaEmbedPage(videoId, lang, fetchFn)
    if (segments.length > 0) return segments
  } catch (e) {
    lastErr = e
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
