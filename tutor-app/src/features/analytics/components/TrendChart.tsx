type TrendPoint = {
  date: string
  value: number
}

type TrendChartProps = {
  title: string
  points: TrendPoint[]
  activeDate: string | null
  onPointClick: (date: string) => void
}

function normalize(points: TrendPoint[]) {
  const values = points.map((p) => p.value)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = Math.max(max - min, 1)
  return points.map((p, idx) => {
    const x = points.length === 1 ? 0 : (idx / (points.length - 1)) * 100
    const y = 92 - ((p.value - min) / range) * 84
    return { ...p, x, y }
  })
}

export function TrendChart({ title, points, activeDate, onPointClick }: TrendChartProps) {
  const rows = normalize(points)
  const path = rows.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const areaPath = `${path} L 100 92 L 0 92 Z`
  const avg = points.length ? Math.round(points.reduce((sum, p) => sum + p.value, 0) / points.length) : 0

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</h2>
        <div className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          среднее: {avg} мин
        </div>
      </div>

      <div className="relative mx-auto h-44 w-full max-w-lg" style={{ minHeight: 170 }}>
        <svg
          viewBox="0 0 100 100"
          className="h-full w-full"
          style={{ display: 'block', width: '100%', height: 170 }}
          aria-label={title}
          preserveAspectRatio="xMidYMid meet"
        >
          <path d="M 0 24 L 100 24" fill="none" stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth="0.6" />
          <path d="M 0 58 L 100 58" fill="none" stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth="0.6" />
          <path d="M 0 92 L 100 92" fill="none" stroke="currentColor" className="text-zinc-300 dark:text-zinc-700" strokeWidth="0.8" />
          <path d={areaPath} className="fill-emerald-500/10 dark:fill-emerald-400/15" />
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            className="text-emerald-500"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {rows.map((p) => (
            <g key={p.date}>
              <circle
                cx={p.x}
                cy={p.y}
                r={activeDate === p.date ? 2 : 1.4}
                className="fill-violet-500"
                style={{ cursor: 'pointer' }}
                onClick={() => onPointClick(p.date)}
              >
                <title>{`${p.date}: ${p.value}`}</title>
              </circle>
            </g>
          ))}
        </svg>
      </div>

      <div className="mx-auto mt-2 flex w-full max-w-lg items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span>{points[0]?.date.slice(5).replace('-', '.')}</span>
        <span>{points[Math.floor(points.length / 2)]?.date.slice(5).replace('-', '.')}</span>
        <span>{points[points.length - 1]?.date.slice(5).replace('-', '.')}</span>
      </div>
    </section>
  )
}
