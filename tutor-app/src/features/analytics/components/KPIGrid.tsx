import type { KPIKey } from '../types'

type KpiItem = {
  key: KPIKey
  title: string
  value: string
  subtitle: string
}

type KPIGridProps = {
  items: KpiItem[]
  activeKey: KPIKey | null
  onSelect: (key: KPIKey) => void
}

export function KPIGrid({ items, activeKey, onSelect }: KPIGridProps) {
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Ключевые показатели">
      {items.map((item) => {
        const active = activeKey === item.key
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item.key)}
            className={`rounded-2xl border px-4 py-3 text-left shadow-sm transition ${
              active
                ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/20 dark:bg-emerald-500/10'
                : 'border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700'
            }`}
            aria-pressed={active}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{item.title}</p>
            <p className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">{item.value}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{item.subtitle}</p>
          </button>
        )
      })}
    </section>
  )
}
