import { useEffect, useState } from 'react'
import type { TshStatus } from '@shared/types'

const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

const fmtRemaining = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}ч ${m}м`
  if (m > 0) return `${m}м ${s}с`
  return `${s}с`
}

/** Индикатор Teleport-сессии: кто/где + обратный отсчёт серта (FR-A5). */
export function StatusBar({
  status,
  loaded
}: {
  status: TshStatus | null
  loaded: boolean
}): React.JSX.Element {
  const now = useNow()

  if (!loaded) return <span className="chip chip-muted">статус: загрузка…</span>
  if (status === null) return <span className="chip chip-red">tsh недоступен</span>
  if (!status.loggedIn) return <span className="chip chip-red">не залогинен</span>

  const validUntil = status.validUntil ? Date.parse(status.validUntil) : null
  const remaining = validUntil === null ? null : validUntil - now
  const expired = remaining !== null && remaining <= 0
  const warning = remaining !== null && remaining > 0 && remaining < 30 * 60 * 1000

  return (
    <>
      <span className={`chip ${expired ? 'chip-red' : warning ? 'chip-yellow' : 'chip-green'}`}>
        ● {status.username}
      </span>
      <span className="chip chip-muted">{status.cluster}</span>
      {status.kubeCluster && <span className="chip chip-muted">kube: {status.kubeCluster}</span>}
      <span className={`chip ${expired ? 'chip-red' : warning ? 'chip-yellow' : 'chip-muted'}`}>
        {expired || remaining === null ? 'серт истёк' : `серт: ${fmtRemaining(remaining)}`}
      </span>
    </>
  )
}
