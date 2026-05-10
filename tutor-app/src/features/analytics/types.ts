export type SkillKey = 'vocab' | 'grammar' | 'listening' | 'speaking' | 'reading'

export type KPIKey = 'streak' | 'minutesThisWeek' | 'reviews' | 'accuracy7d'

export type DailySkillBreakdown = Record<SkillKey, number>

export type DaySession = {
  id: string
  label: string
  minutes: number
  reviewsDone: number
  accuracy: number
}

export type DayMistake = {
  id: string
  skill: SkillKey
  prompt: string
  expected: string
  answer: string
}

export type DailyAnalytics = {
  date: string
  minutes: number
  reviewsDone: number
  reviewsDue: number
  accuracy: number
  skills: DailySkillBreakdown
  sessions: DaySession[]
  mistakes: DayMistake[]
}

export type AnalyticsDataset = {
  kpis: {
    streak: number
    minutesThisWeek: number
    reviewsDone: number
    reviewsDue: number
    accuracy7d: number
  }
  trend7d: DailyAnalytics[]
  trend30d: DailyAnalytics[]
  days: DailyAnalytics[]
  insight: {
    title: string
    body: string
    action: string
  }
}
