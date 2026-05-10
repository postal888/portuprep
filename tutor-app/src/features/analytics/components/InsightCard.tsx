type InsightCardProps = {
  title: string
  body: string
  action: string
}

export function InsightCard({ title, body, action }: InsightCardProps) {
  return (
    <section className="rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-50 to-white p-4 shadow-sm dark:from-emerald-500/10 dark:to-zinc-900">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-200">{title}</p>
      <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-200">{body}</p>
      <p className="mt-2 text-sm font-semibold text-emerald-700 dark:text-emerald-200">{action}</p>
    </section>
  )
}
