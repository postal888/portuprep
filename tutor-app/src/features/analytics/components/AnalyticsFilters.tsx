type AnalyticsFiltersProps = {
  range: '7d' | '30d'
  onRangeChange: (next: '7d' | '30d') => void
  skill: 'all' | 'vocab' | 'grammar' | 'listening' | 'speaking' | 'reading'
  onSkillChange: (next: AnalyticsFiltersProps['skill']) => void
}

const rangeOptions: Array<{ id: '7d' | '30d'; label: string }> = [
  { id: '7d', label: '7 дней' },
  { id: '30d', label: '30 дней' },
]

const skillOptions: Array<{ id: AnalyticsFiltersProps['skill']; label: string }> = [
  { id: 'all', label: 'Все навыки' },
  { id: 'vocab', label: 'Лексика' },
  { id: 'grammar', label: 'Грамматика' },
  { id: 'listening', label: 'Аудирование' },
  { id: 'speaking', label: 'Говорение' },
  { id: 'reading', label: 'Чтение' },
]

export function AnalyticsFilters({ range, onRangeChange, skill, onSkillChange }: AnalyticsFiltersProps) {
  return (
    <section
      className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      aria-label="Фильтры аналитики"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="inline-flex rounded-full bg-zinc-100 p-1 dark:bg-zinc-800">
          {rangeOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onRangeChange(option.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                range === option.id
                  ? 'bg-emerald-500 text-white'
                  : 'text-zinc-700 hover:bg-white dark:text-zinc-200 dark:hover:bg-zinc-700'
              }`}
              aria-pressed={range === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
          Навык:
          <select
            className="rounded-lg border border-zinc-300 bg-white px-3 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-800"
            value={skill}
            onChange={(e) => onSkillChange(e.target.value as AnalyticsFiltersProps['skill'])}
          >
            {skillOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}
