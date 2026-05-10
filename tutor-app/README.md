# PortuPrep — tutor-app

## Evaluate difficulty (Portuguese)

Deterministic, explainable difficulty analysis for plain text and YouTube subtitles (lexical, syntactic, structural, and subtitle timing features). The engine lives in `lib/difficulty/`. **Surface readability** (`score`) is distinct from **learner comprehension difficulty** (`learnerComprehensionDifficulty`): the latter adds calibrated weight for literary-fiction cues (dialogue density, lexical diversity, sparse explicit cohesion markers, pronoun/anaphora load, narrative vocabulary, uneven sentence lengths). Subtitle mode dampens those cues so dialogue-heavy transcripts are not double-counted. Vite dev/preview middleware exposes JSON APIs and persists analyses to `data/difficulty-analyses.json`.

### API (dev / `vite preview`)

- `GET /api/health` — includes `{ difficulty: true }`
- `POST /api/difficulty/analyze` — body: `{ mode: "text", text }` or `{ mode: "subtitles", segments: [{ text, startMs, endMs }], videoDurationMs? }`
- `POST /api/difficulty/analyze-by-text-id` — `{ textId, plainText }` (client sends the current book text; there is no server-side book store)
- `POST /api/difficulty/analyze-by-video-id` — `{ videoId, segments, videoDurationMs? }`
- `GET /api/difficulty/latest?sourceType=TEXT|VIDEO&sourceId=...`
- `GET /api/difficulty/history?sourceType=&sourceId=&limit=50`

JSON responses include surface `score` / `band` / `cefrEstimate`, `probableGenre` (`learner_material` | `subtitle` | `informative` | `literary` | `legal_academic`), per-genre weights in `features` (`genreLiterary`, …), plus `learnerComprehensionDifficulty` (alias `learner_comprehension_difficulty`) / `learnerBand` / `learnerCefrEstimate`, `contributions.literaryComprehensionLift`, and keys such as `literaryFictionComposite` and `comprehensionLiftPoints`. For **literary**-weighted text, surface score is a blend that favours lexical diversity, discourse/cohesion proxies, pronoun–anaphora load, and contextual difficulty over the default readability mix.

### UI

In `public/portuprep-extracted.html`, use **Оценить сложность** on the reader toolbar (with a book open) or next to the transcript controls (with subtitles loaded).

### Commands

```bash
npm install
npm run dev
```

```bash
npm run test
```

Typecheck (Node / middleware + `lib`):

```bash
npx tsc -p tsconfig.node.json --noEmit
```
