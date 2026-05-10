import type { DailyAnalytics, KPIKey } from '../types'

type DayDetailDrawerProps = {
  open: boolean
  day: DailyAnalytics | null
  metric: KPIKey | null
  onClose: () => void
}

function metricTitle(metric: KPIKey | null) {
  if (metric === 'streak') return 'Streak breakdown'
  if (metric === 'minutesThisWeek') return 'Минуты по дням'
  if (metric === 'reviews') return 'Reviews done / due'
  if (metric === 'accuracy7d') return 'Accuracy detail'
  return 'Детали дня'
}

export function DayDetailDrawer({ open, day, metric, onClose }: DayDetailDrawerProps) {
  return (
    <div
      className={`fixed inset-0 z-50 transition ${open ? 'pointer-events-auto' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        className={`absolute inset-0 bg-black/30 transition ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
        aria-label="Закрыть детали"
      />
      <aside
        className={`absolute right-0 top-0 h-full w-full max-w-md transform border-l border-zinc-200 bg-white p-4 shadow-xl transition dark:border-zinc-800 dark:bg-zinc-900 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">{day ? day.date : 'Метрика'}</h3>
            <p className="text-[11px] text-zinc-500">{metricTitle(metric)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-2 py-1 text-[11px] font-medium dark:border-zinc-700"
          >
            Закрыть
          </button>
        </header>

        {!day ? (
          <p className="text-sm text-zinc-500">Выберите день на календаре или точку на графике.</p>
        ) : (
          <div className="space-y-4 overflow-y-auto pb-10">
            <section>
              <h4 className="mb-2 text-sm font-semibold">Сводка</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-xl bg-zinc-100 p-2 dark:bg-zinc-800">Минуты: {day.minutes}</div>
                <div className="rounded-xl bg-zinc-100 p-2 dark:bg-zinc-800">Точность: {day.accuracy}%</div>
                <div className="rounded-xl bg-zinc-100 p-2 dark:bg-zinc-800">Reviews done: {day.reviewsDone}</div>
                <div className="rounded-xl bg-zinc-100 p-2 dark:bg-zinc-800">Reviews due: {day.reviewsDue}</div>
              </div>
            </section>

            <section>
              <h4 className="mb-2 text-sm font-semibold">Сессии</h4>
              <ul className="space-y-2">
                {day.sessions.map((session) => (
                  <li key={session.id} className="rounded-xl border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                    <p className="font-medium">{session.label}</p>
                    <p className="text-[11px] text-zinc-500">
                      {session.minutes} мин · {session.reviewsDone} reviews · {session.accuracy}%
                    </p>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h4 className="mb-2 text-sm font-semibold">Ошибки</h4>
              {day.mistakes.length === 0 ? (
                <p className="text-sm text-zinc-500">Ошибок за день не зафиксировано.</p>
              ) : (
                <ul className="space-y-2">
                  {day.mistakes.map((m) => (
                    <li key={m.id} className="rounded-xl border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                      <p className="font-medium">{m.prompt}</p>
                      <p className="text-[11px] text-zinc-500">
                        Ваш ответ: {m.answer} · Верно: {m.expected}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}
