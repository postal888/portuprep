/**
 * Оболочка Vite: весь UI, стили и логика — в {@link /portuprep-extracted.html}
 * (извлечено из «как на счет сделать свой софт для подготовки к португальскому.html»).
 */
import { AnalyticsDashboard } from './features/analytics/AnalyticsDashboard'

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const showAnalytics = params.get('analytics') === '1'

  if (showAnalytics) return <AnalyticsDashboard />

  return (
    <iframe
      className="portuprep-frame"
      title="PortuPrep"
      src="/portuprep-extracted.html"
    />
  )
}
