import { useEffect, useMemo, useState } from 'react'
import { analyticsMockData, skillLabel } from './mockData'
import type { KPIKey, SkillKey } from './types'
import { AnalyticsFilters } from './components/AnalyticsFilters'
import { DayDetailDrawer } from './components/DayDetailDrawer'
import { InsightCard } from './components/InsightCard'
import { KPIGrid } from './components/KPIGrid'
import { SkillBreakdownChart } from './components/SkillBreakdownChart'
import { StudyCalendarHeatmap } from './components/StudyCalendarHeatmap'
import { TrendChart } from './components/TrendChart'

function monthGrid(days: typeof analyticsMockData.days) {
  const target = new Date(days[days.length - 1]?.date ?? new Date().toISOString().slice(0, 10))
  const year = target.getFullYear()
  const month = target.getMonth()
  const first = new Date(year, month, 1)
  const firstDow = (first.getDay() + 6) % 7
  const monthDays = new Date(year, month + 1, 0).getDate()
  const prevMonthDays = new Date(year, month, 0).getDate()
  const cells: Array<{ date: string; isCurrentMonth: boolean; minutes: number }> = []
  const byDate = new Map(days.map((d) => [d.date, d]))

  for (let i = 0; i < firstDow; i++) {
    const d = new Date(year, month - 1, prevMonthDays - firstDow + i + 1)
    const iso = d.toISOString().slice(0, 10)
    cells.push({ date: iso, isCurrentMonth: false, minutes: byDate.get(iso)?.minutes ?? 0 })
  }
  for (let i = 1; i <= monthDays; i++) {
    const d = new Date(year, month, i)
    const iso = d.toISOString().slice(0, 10)
    cells.push({ date: iso, isCurrentMonth: true, minutes: byDate.get(iso)?.minutes ?? 0 })
  }
  while (cells.length % 7 !== 0) {
    const d = new Date(year, month + 1, cells.length % 7)
    const iso = d.toISOString().slice(0, 10)
    cells.push({ date: iso, isCurrentMonth: false, minutes: byDate.get(iso)?.minutes ?? 0 })
  }

  return {
    title: new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(target),
    cells,
  }
}

export function AnalyticsDashboard() {
  const THEME_KEY = 'portuprep_analytics_theme_v1'
  const [range, setRange] = useState<'7d' | '30d'>('7d')
  const [skill, setSkill] = useState<'all' | SkillKey>('all')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [selectedMetric, setSelectedMetric] = useState<KPIKey | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY)
      if (saved === 'light' || saved === 'dark') return saved
    } catch (e) {}
    return 'dark'
  })

  const trendSource = range === '7d' ? analyticsMockData.trend7d : analyticsMockData.trend30d
  const trendPoints = trendSource.map((d) => ({
    date: d.date,
    value: skill === 'all' ? d.minutes : d.skills[skill],
  }))

  const selectedDay = useMemo(
    () => analyticsMockData.days.find((d) => d.date === selectedDate) ?? null,
    [selectedDate],
  )

  const skillTotals = useMemo(() => {
    const base = selectedDay ? [selectedDay] : trendSource
    const totals = {
      vocab: 0,
      grammar: 0,
      listening: 0,
      speaking: 0,
      reading: 0,
    }
    const accuracyCounts: Record<SkillKey, number> = {
      vocab: 0,
      grammar: 0,
      listening: 0,
      speaking: 0,
      reading: 0,
    }
    for (const d of base) {
      ;(Object.keys(totals) as SkillKey[]).forEach((k) => {
        totals[k] += d.skills[k]
        if (d.skills[k] > 0) accuracyCounts[k] += d.accuracy
      })
    }
    return (Object.keys(totals) as SkillKey[]).map((k) => ({
      skill: k,
      label: skillLabel[k],
      minutes: totals[k],
      accuracy: Math.max(0, Math.min(100, Math.round(accuracyCounts[k] / Math.max(1, base.length)))),
    }))
  }, [selectedDay, trendSource])

  const kpis = [
    {
      key: 'streak' as const,
      title: 'streak',
      value: `${analyticsMockData.kpis.streak} дн`,
      subtitle: 'Непрерывные учебные дни',
    },
    {
      key: 'minutesThisWeek' as const,
      title: 'минут на неделе',
      value: `${analyticsMockData.kpis.minutesThisWeek}`,
      subtitle: 'Общая нагрузка',
    },
    {
      key: 'reviews' as const,
      title: 'reviews',
      value: `${analyticsMockData.kpis.reviewsDone}/${analyticsMockData.kpis.reviewsDue}`,
      subtitle: 'Сделано / ожидает',
    },
    {
      key: 'accuracy7d' as const,
      title: 'точность 7д',
      value: `${analyticsMockData.kpis.accuracy7d}%`,
      subtitle: 'Средняя успешность',
    },
  ]

  const cal = monthGrid(analyticsMockData.days)

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch (e) {}
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.body.classList.toggle('dark', theme === 'dark')
  }, [theme])

  function openMainApp() {
    window.location.href = '/'
  }

  return (
    <main className={theme === 'dark' ? 'dark' : ''}>
      <div className="min-h-screen bg-zinc-50 p-4 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 md:p-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <header className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium dark:bg-zinc-800">Teacher side</span>
              <span className="rounded-full px-2.5 py-1">Class</span>
              <span className="rounded-full px-2.5 py-1">Student</span>
              <span className="rounded-full px-2.5 py-1">Discipline</span>
            </div>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h1 className="text-lg font-semibold">PortuPrep Analytics</h1>
                <p className="text-sm text-zinc-500">Календарь, нагрузка, слабые зоны и drill-down за день.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTheme((v) => (v === 'dark' ? 'light' : 'dark'))}
                  className="w-fit rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {theme === 'dark' ? 'Светлая тема' : 'Темная тема'}
                </button>
                <button
                  type="button"
                  onClick={openMainApp}
                  className="w-fit rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium dark:border-zinc-700 dark:bg-zinc-900"
                >
                  Вернуться в приложение
                </button>
              </div>
            </div>
          </header>

          <AnalyticsFilters range={range} onRangeChange={setRange} skill={skill} onSkillChange={setSkill} />

          <KPIGrid
            items={kpis}
            activeKey={selectedMetric}
            onSelect={(key) => {
              setSelectedMetric(key)
              if (!selectedDate) setSelectedDate(trendSource[trendSource.length - 1]?.date ?? null)
              setDrawerOpen(true)
            }}
          />

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <div className="lg:col-span-1">
              <StudyCalendarHeatmap
                monthTitle={cal.title}
                days={cal.cells}
                selectedDate={selectedDate}
                onSelectDate={(date) => {
                  setSelectedDate(date)
                  setDrawerOpen(true)
                }}
              />
            </div>

            <div className="grid grid-cols-1 items-start gap-4">
              <div className="w-full max-w-xl">
                <TrendChart
                  title={range === '7d' ? 'Тренд за 7 дней' : 'Тренд за 30 дней'}
                  points={trendPoints}
                  activeDate={selectedDate}
                  onPointClick={(date) => {
                    setSelectedDate(date)
                    setDrawerOpen(true)
                  }}
                />
              </div>
              <div className="w-full max-w-2xl">
                <SkillBreakdownChart
                  data={skillTotals}
                  activeSkill={skill}
                  onSelectSkill={(next) => setSkill(next)}
                />
              </div>
            </div>
          </section>

          <InsightCard
            title={analyticsMockData.insight.title}
            body={analyticsMockData.insight.body}
            action={analyticsMockData.insight.action}
          />
        </div>
      </div>

      <DayDetailDrawer
        open={drawerOpen}
        day={selectedDay}
        metric={selectedMetric}
        onClose={() => setDrawerOpen(false)}
      />
    </main>
  )
}
