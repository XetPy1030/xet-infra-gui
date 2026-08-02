import { useState } from 'react'
import { isProxyOn } from '@shared/proxy'
import type { ProxyRunState, ProxyView } from '@shared/types'
import { rpc } from '../api'
import { startProxy } from '../proxy'
import { useApp } from '../store'

const STATE_LABELS: Record<ProxyRunState, string> = {
  off: 'выкл',
  starting: 'запускается…',
  awaiting_otp: 'ждёт код',
  probing: 'проверка порта…',
  healthy: 'работает',
  degraded: 'деградация',
  restarting: 'рестарт…',
  error: 'ошибка'
}

const stateClass = (s: ProxyRunState): string =>
  s === 'healthy' ? 'chip-green'
  : s === 'off' ? 'chip-muted'
  : s === 'error' || s === 'degraded' ? 'chip-red'
  : 'chip-yellow'

/** Тумблеры DB-прокси (docs/02 §2): вкл/выкл, честные состояния, prod — красный. */
export function ProxyPanel(): React.JSX.Element | null {
  const { proxies, proxyOrder, setActive } = useApp()
  const [busy, setBusy] = useState<string | null>(null)

  const firstId = proxyOrder[0]
  if (!firstId) return null
  const port = proxies[firstId]?.port

  const toggle = async (view: ProxyView): Promise<void> => {
    setBusy(view.presetId)
    try {
      if (isProxyOn(view.state)) {
        await rpc('proxy.stop', { presetId: view.presetId })
        return
      }
      await startProxy(view)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="proxybar">
      <span className="proxybar-title">DB PROXY · порт {port}</span>
      {proxyOrder.map((id) => {
        const view = proxies[id]
        if (!view) return null
        return (
          <div key={id} className={`proxy ${view.env === 'prod' ? 'proxy-prod' : ''}`}>
            <button
              className={`toggle ${isProxyOn(view.state) ? 'toggle-on' : ''}`}
              disabled={busy === id}
              title={view.error ?? `tsh proxy db --tunnel (${view.label})`}
              onClick={() => void toggle(view)}
            >
              <span className="knob" />
            </button>
            <span className="proxy-label">
              {view.env === 'prod' ? '🔴 ' : ''}
              {view.label}
            </span>
            <span
              className={`chip ${stateClass(view.state)}`}
              title={view.error ?? undefined}
              onClick={() => view.sessionId && setActive(view.sessionId)}
              style={view.sessionId ? { cursor: 'pointer' } : undefined}
            >
              {STATE_LABELS[view.state]}
              {view.attempts > 0 && view.state !== 'healthy' ? ` (${view.attempts})` : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}
