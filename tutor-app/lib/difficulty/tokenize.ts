import { normalizeLemma } from './lexicon.ts'

const SENT_SPLIT = /(?<=[.!?…])\s+/gu

export function stripNoise(s: string): string {
  return s
    .replace(/\[(?:music|musica|applause|laughter|inaudible|foreign|cc)\]/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return []
  const parts = t.split(SENT_SPLIT).map((x) => x.trim()).filter(Boolean)
  return parts.length ? parts : [t]
}

/** Word tokens (letters only), lowercased lemmas for matching. */
export function wordsFromText(text: string): string[] {
  const out: string[] = []
  const re = /[\p{L}\p{M}]+/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const raw = m[0]
    if (raw.length >= 1) out.push(raw)
  }
  return out
}

export function lemmas(words: string[]): string[] {
  return words.map((w) => normalizeLemma(w)).filter((x) => x.length > 0)
}
