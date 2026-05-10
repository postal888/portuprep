import type { SkillKey } from '../types'

type SkillBar = {
  skill: SkillKey
  label: string
  minutes: number
  accuracy: number
}

type SkillBreakdownChartProps = {
  data: SkillBar[]
  activeSkill: SkillKey | 'all'
  onSelectSkill: (skill: SkillKey | 'all') => void
}

const skillColor: Record<SkillKey, string> = {
  vocab: 'bg-emerald-500',
  grammar: 'bg-violet-500',
  listening: 'bg-emerald-500/75',
  speaking: 'bg-violet-500/75',
  reading: 'bg-emerald-500/55',
}

export function SkillBreakdownChart({ data, activeSkill, onSelectSkill }: SkillBreakdownChartProps) {
  const total = Math.max(1, data.reduce((sum, row) => sum + row.minutes, 0))

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Распределение навыков</h2>
        <button
          type="button"
          onClick={() => onSelectSkill('all')}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            activeSkill === 'all'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
          }`}
        >
          Сбросить
        </button>
      </header>

      <div className="space-y-2.5">
        {data.map((row) => {
          const pct = (row.minutes / total) * 100
          const active = activeSkill === row.skill
          return (
            <button
              key={row.skill}
              type="button"
              onClick={() => onSelectSkill(row.skill)}
              className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                active
                  ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500/20 dark:bg-emerald-500/10'
                  : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
              }`}
              aria-pressed={active}
            >
              <div className="mb-2 flex items-center justify-between text-[11px]">
                <span className="font-medium">{row.label}</span>
                <span className="text-zinc-500">{row.minutes} мин · {row.accuracy}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                <div className={`h-full ${skillColor[row.skill]}`} style={{ width: `${pct}%` }} />
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
