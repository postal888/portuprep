type HeatmapDay = {
  date: string
  minutes: number
  isCurrentMonth: boolean
}

type StudyCalendarHeatmapProps = {
  monthTitle: string
  days: HeatmapDay[]
  selectedDate: string | null
  onSelectDate: (date: string) => void
}

function intensity(minutes: number) {
  if (minutes <= 0) return 'bg-zinc-100 dark:bg-zinc-800'
  if (minutes < 20) return 'bg-emerald-100 dark:bg-emerald-500/25'
  if (minutes < 40) return 'bg-emerald-500/50 dark:bg-emerald-500/45'
  return 'bg-emerald-500 dark:bg-emerald-500'
}

export function StudyCalendarHeatmap({ monthTitle, days, selectedDate, onSelectDate }: StudyCalendarHeatmapProps) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Календарь активности</h2>
        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800">{monthTitle}</span>
      </header>

      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-zinc-500">
        {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => (
          <div key={d} className="pb-1">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {days.map((day) => {
          const dayLabel = Number(day.date.slice(-2))
          const selected = selectedDate === day.date
          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onSelectDate(day.date)}
              className={`aspect-square rounded-lg border text-[11px] font-medium transition ${
                day.isCurrentMonth ? '' : 'opacity-40'
              } ${intensity(day.minutes)} ${
                selected ? 'border-violet-500 ring-2 ring-violet-500/40' : 'border-transparent'
              }`}
              title={`${day.date}: ${day.minutes} мин`}
            >
              {dayLabel}
            </button>
          )
        })}
      </div>
    </section>
  )
}
