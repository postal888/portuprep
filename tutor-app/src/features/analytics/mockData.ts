import type { AnalyticsDataset, DailyAnalytics, DayMistake, DaySession, SkillKey } from './types'

const SKILLS: SkillKey[] = ['vocab', 'grammar', 'listening', 'speaking', 'reading']

const skillLabel: Record<SkillKey, string> = {
  vocab: 'Лексика',
  grammar: 'Грамматика',
  listening: 'Аудирование',
  speaking: 'Говорение',
  reading: 'Чтение',
}

function isoDate(daysAgo: number): string {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

function buildSessions(seed: number, minutes: number, accuracy: number): DaySession[] {
  if (minutes === 0) return []
  const blocks = Math.max(1, Math.min(4, Math.round(minutes / 20)))
  const out: DaySession[] = []
  let remain = minutes
  for (let i = 0; i < blocks; i++) {
    const isLast = i === blocks - 1
    const part = isLast ? remain : Math.max(8, Math.round((minutes / blocks) * (0.8 + ((seed + i) % 3) * 0.1)))
    remain -= part
    out.push({
      id: `sess-${seed}-${i}`,
      label: ['Карточки', 'Читалка', 'Субтитры', 'Тесты'][i % 4],
      minutes: Math.max(5, part),
      reviewsDone: Math.max(0, Math.round(part * 1.8)),
      accuracy: Math.max(48, Math.min(98, accuracy + (i % 2 === 0 ? 2 : -3))),
    })
  }
  return out
}

function buildMistakes(seed: number, count: number): DayMistake[] {
  const out: DayMistake[] = []
  const mistakesPool = [
    ['grammar', 'Ser vs Estar: "Ela ___ cansada"', 'está', 'é'],
    ['vocab', 'Перевод "saudade"', 'тоска', 'радость'],
    ['listening', 'Распознать фразу "a gente vai"', 'мы идем', 'я иду'],
    ['reading', 'Смысл "dar conta de"', 'справляться', 'учитывать'],
    ['speaking', 'Спряжение "fazer" для "eu"', 'faço', 'fazo'],
  ] as const
  for (let i = 0; i < count; i++) {
    const row = mistakesPool[(seed + i) % mistakesPool.length]
    out.push({
      id: `m-${seed}-${i}`,
      skill: row[0],
      prompt: row[1],
      expected: row[2],
      answer: row[3],
    })
  }
  return out
}

function buildDay(daysAgo: number): DailyAnalytics {
  const date = isoDate(daysAgo)
  const wave = Math.sin((daysAgo + 2) / 3.2)
  const base = Math.max(0, Math.round(42 + wave * 28 - daysAgo * 0.3))
  const isRestDay = daysAgo % 9 === 0
  const minutes = isRestDay ? 0 : Math.max(12, base)
  const accuracy = minutes === 0 ? 0 : Math.max(56, Math.min(96, Math.round(72 + Math.cos(daysAgo / 4) * 12)))
  const reviewsDone = minutes === 0 ? 0 : Math.round(minutes * 2.1)
  const reviewsDue = Math.max(8, Math.round(22 + (daysAgo % 7) * 2.2))
  const skills: Record<SkillKey, number> = {
    vocab: Math.round(minutes * (0.28 + (daysAgo % 3) * 0.02)),
    grammar: Math.round(minutes * (0.22 + (daysAgo % 4) * 0.015)),
    listening: Math.round(minutes * (0.2 + ((daysAgo + 1) % 4) * 0.015)),
    speaking: Math.round(minutes * (0.14 + (daysAgo % 5) * 0.01)),
    reading: 0,
  }
  const used = SKILLS.reduce((sum, k) => sum + skills[k], 0)
  skills.reading = Math.max(0, minutes - used)

  const mistakesCount = minutes === 0 ? 0 : Math.max(0, Math.round((100 - accuracy) / 9))

  return {
    date,
    minutes,
    reviewsDone,
    reviewsDue,
    accuracy,
    skills,
    sessions: buildSessions(daysAgo, minutes, accuracy),
    mistakes: buildMistakes(daysAgo, mistakesCount),
  }
}

const days: DailyAnalytics[] = Array.from({ length: 35 }, (_, i) => buildDay(34 - i))
const trend30d = days.slice(-30)
const trend7d = days.slice(-7)
const week = trend7d

export const analyticsMockData: AnalyticsDataset = {
  days,
  trend7d,
  trend30d,
  kpis: {
    streak: 18,
    minutesThisWeek: week.reduce((sum, d) => sum + d.minutes, 0),
    reviewsDone: week.reduce((sum, d) => sum + d.reviewsDone, 0),
    reviewsDue: week.reduce((sum, d) => sum + d.reviewsDue, 0),
    accuracy7d: Math.round(week.filter((d) => d.minutes > 0).reduce((sum, d) => sum + d.accuracy, 0) / 7),
  },
  insight: {
    title: 'Инсайт недели',
    body: 'Аудирование стабильно растет, но ошибки в грамматике после 20:00 увеличиваются почти вдвое.',
    action: 'Рекомендуем 15-минутный grammar-drill после каждого просмотра субтитров.',
  },
}

export { skillLabel }
