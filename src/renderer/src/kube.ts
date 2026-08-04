import type { EnvId, KubeSessionResult, PodInfo } from '@shared/types'
import { useApp } from './store'

/**
 * Запуск kube-сессии (bash/логи/команда в PTY): успех — новый таб в фокусе,
 * ошибка — баннер (main уже сказал, пахнет ли это перелогином).
 */
export async function runKubeSession(run: () => Promise<KubeSessionResult>): Promise<boolean> {
  const s = useApp.getState()
  s.setAppError(null)
  const res = await run()
  if (!res.ok) {
    s.setAppError({ message: res.error, needsLogin: res.needsLogin === true })
    return false
  }
  s.upsertSession(res.session)
  s.setKubeSession(res.meta.sessionId, res.meta)
  s.setActive(res.session.id)
  return true
}

/**
 * Prod-guard (US-14, docs/02 §5): shell и выполнение команд на боевом кластере —
 * только с подтверждением. Логи read-only и подтверждения не требуют.
 */
export function confirmProd(env: EnvId, action: string): boolean {
  return env !== 'prod' || window.confirm(`PROD: ${action}. Продолжить?`)
}

/** Под «обслуживает трафик»: Running и все контейнеры ready (цвет бейджа). */
export const isServing = (p: PodInfo): boolean =>
  p.phase === 'Running' && p.totalCount > 0 && p.readyCount === p.totalCount
