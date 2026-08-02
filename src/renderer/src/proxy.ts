import type { ProxyView } from '@shared/types'
import { rpc } from './api'

/**
 * Включение DB-прокси со всеми вопросами пользователю: подтверждение боевой
 * базы, переключение общего порта (стратегия `shared`), занятый чужим порт.
 * Живёт отдельно, потому что зовётся из двух мест — тумблеров и SQL-консоли,
 * а расходиться этим диалогам нельзя.
 */
export async function startProxy(view: ProxyView): Promise<boolean> {
  if (view.dangerous && !window.confirm(`Включить прокси «${view.label}» (PROD)?`)) return false
  const res = await rpc('proxy.start', { presetId: view.presetId })
  if (res.ok) return true
  if (res.reason === 'conflict') {
    const switchOver = window.confirm(
      `Порт ${view.port} общий: выключить «${res.conflictLabel}» и включить «${view.label}»?`
    )
    if (!switchOver) return false
    return (await rpc('proxy.start', { presetId: view.presetId, force: true })).ok
  }
  if (res.reason === 'busy-port') window.alert(res.hint)
  return false
}
