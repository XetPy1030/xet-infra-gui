import { useState } from 'react'
import type { EnvId } from '@shared/types'
import { rpc } from '../api'
import { confirmProd, runKubeSession } from '../kube'
import { useApp } from '../store'

const ENVS: EnvId[] = ['dev', 'stage', 'prod']

/**
 * Быстрые kube-действия и выбор окружения (docs/02 §2/§3): те же действия, что
 * в popover трея — окружение одно на приложение (владеет KubeService в main).
 */
export function KubeBar(): React.JSX.Element | null {
  const { kube } = useApp()
  const [busy, setBusy] = useState(false)

  // пустой namespace — kube в конфиге не настроен, показывать нечего
  if (!kube || kube.namespace === '') return null
  const mismatch = kube.currentCluster !== kube.cluster

  const withBusy = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kubebar">
      <span className="kubebar-title">KUBE · {kube.namespace}</span>

      <div className="envs">
        {ENVS.map((env) => (
          <button
            key={env}
            className={`env ${kube.env === env ? 'env-active' : ''} ${env === 'prod' ? 'env-prod' : ''}`}
            disabled={busy || kube.switching}
            onClick={() => void withBusy(() => rpc('kube.setEnv', { env }))}
          >
            {env === 'prod' ? '🔴 prod' : env}
          </button>
        ))}
      </div>

      <span
        className={`chip ${kube.switching ? 'chip-yellow' : mismatch ? 'chip-muted' : 'chip-green'}`}
        title={
          mismatch ?
            `Активен ${kube.currentCluster ?? '—'}; действие само выполнит tsh kube login`
          : 'Кластер активен'
        }
      >
        {kube.cluster}
        {kube.switching ? ' — переключаю…' : mismatch ? ' — не активен' : ''}
      </span>

      {kube.workloads.map((w) => (
        <span key={w.id} className="kube-actions">
          <button
            disabled={busy || kube.switching}
            title={`tsh kubectl exec -it <свежайший под ${w.title}> -- bash`}
            onClick={() => {
              if (!confirmProd(kube.env, `bash в свежайший под «${w.title}»`)) return
              void withBusy(() =>
                runKubeSession(() => rpc('kube.bash', { env: kube.env, workloadId: w.id }))
              )
            }}
          >
            Bash → {w.title}
          </button>
          <button
            disabled={busy || kube.switching}
            title={`tsh kubectl logs --follow <свежайший под ${w.title}>`}
            onClick={() =>
              void withBusy(() =>
                runKubeSession(() => rpc('kube.logs', { env: kube.env, workloadId: w.id }))
              )
            }
          >
            Логи → {w.title}
          </button>
        </span>
      ))}
    </div>
  )
}
