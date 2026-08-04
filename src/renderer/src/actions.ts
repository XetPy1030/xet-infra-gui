import type { ActionResult } from '@shared/types'
import { rpc } from './api'
import { useApp } from './store'

/** Столько же вопросов подряд, сколько допускает main (prod + общий порт). */
const MAX_CONFIRMS = 4

/**
 * Запуск действия из окна (ADR-0004). Что спрашивать — решает само действие в
 * ядре; здесь только показ вопроса и разбор ответа. Тот же цикл, что в
 * `main/actions.ts` для трея, но вопросы — `window.confirm`, а не нативный
 * диалог: так их видит и автоматизация прогонов.
 */
export async function runAction(
  id: string,
  opts: { param?: string } = {}
): Promise<ActionResult> {
  const store = useApp.getState()
  store.setAppError(null)
  const confirmed: string[] = []
  let last: ActionResult = { ok: false, reason: 'failed', error: 'Действие не выполнено' }

  for (let step = 0; step <= MAX_CONFIRMS; step += 1) {
    last = await rpc('actions.run', { id, param: opts.param, confirmed })
    if (last.ok) {
      if (last.reveal) store.applyReveal(last.reveal)
      return last
    }
    if (last.reason === 'needs-confirm') {
      if (!window.confirm(last.error)) return last
      confirmed.push(last.confirmKey)
      continue
    }
    // needs-param спрашивает палитра до запуска — баннером его показывать незачем
    if (last.reason !== 'needs-param') {
      store.setAppError({ message: last.error, needsLogin: last.needsLogin === true })
    }
    return last
  }
  return last
}
