import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ageOf } from '@shared/age'
import type { EnvId, PodInfo } from '@shared/types'
import { rpc } from '../api'
import { confirmProd, isServing, runKubeSession } from '../kube'
import { useApp } from '../store'

/** Возраст списка, после которого он считается устаревшим (docs/02 §3 «Поды»). */
const STALE_MS = 30_000
/** Как часто проверяем «не пора ли»: сам запрос уходит только на устаревшем списке. */
const TICK_MS = 5_000

interface Group {
  id: string | null
  title: string
  pods: PodInfo[]
  freshest: string | null
}

const phaseClass = (p: PodInfo): string =>
  isServing(p) ? 'chip-green'
  : p.phase === 'Running' || p.phase === 'Pending' ? 'chip-yellow'
  : // Succeeded — обычное состояние отработавших подов, не ошибка
    p.phase === 'Succeeded' ? 'chip-muted'
  : 'chip-red'

/**
 * Раздел «Поды» (US-05, FR-K2): таблица с группировкой по workload'ам, age в
 * стиле kubectl, бейдж «свежий» на том поде, который выберут быстрые действия.
 * Любой под можно взять вручную — включая группу «прочее».
 *
 * Список живёт в сторе: перейти на таб сессии и вернуться — бесплатно, запрос
 * уходит только когда данные устарели, окно видимо или нажали «Обновить».
 */
export function PodsPanel(): React.JSX.Element {
  const { kube, pods, setPods } = useApp()
  const env = kube?.env ?? 'dev'
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [onlyRunning, setOnlyRunning] = useState(true)
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(Date.now())
  const [cmdPod, setCmdPod] = useState<string | null>(null)
  const inFlight = useRef(false)

  const data = pods?.env === env ? pods : null

  const refresh = useCallback(
    async (force: boolean): Promise<void> => {
      if (inFlight.current) return // тик и кнопка не должны слать два запроса подряд
      inFlight.current = true
      setLoading(true)
      try {
        const res = await rpc('kube.pods', { env, force })
        if (res.ok) {
          setPods({ env, pods: res.pods, freshest: res.freshest, fetchedAt: res.fetchedAt, cluster: res.cluster })
          setError(null)
        } else {
          // ошибка раздела — здесь же, а не общим баннером: тот для действий из бара
          setError(res.error)
        }
      } finally {
        inFlight.current = false
        setLoading(false)
      }
    },
    [env, setPods]
  )

  // Данные прошлого запроса показываем сразу (stale-while-revalidate), запрос
  // уходит только за устаревшими и только при видимом окне — оно menu-bar'ное и
  // большую часть времени скрыто, фоновой опрос там был бы чистой тратой.
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === 'hidden') return
      const cur = useApp.getState().pods
      if (cur?.env === env && Date.now() - cur.fetchedAt < STALE_MS) return
      void refresh(false)
    }
    tick()
    const timer = setInterval(tick, TICK_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [env, refresh])

  // age тикает сам, без перезапроса подов
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const groups = useMemo<Group[]>(() => {
    if (!data) return []
    const needle = query.trim().toLowerCase()
    const visible = data.pods.filter(
      (p) =>
        (!onlyRunning || p.phase === 'Running') &&
        (needle.length === 0 || p.name.toLowerCase().includes(needle))
    )
    const result: Group[] = (kube?.workloads ?? []).map((w) => ({
      id: w.id,
      title: w.title,
      // свежайший сверху: при rollout'е интересен именно он
      pods: visible.filter((p) => p.workloadId === w.id).sort(byStartDesc),
      freshest: data.freshest[w.id] ?? null
    }))
    const rest = visible.filter((p) => p.workloadId === null)
    if (rest.length > 0) result.push({ id: null, title: 'прочее', pods: rest, freshest: null })
    return result
  }, [data, kube, onlyRunning, query])

  return (
    <div className="pods">
      <div className="pods-head">
        <b>Поды {kube?.namespace}</b>
        <span className="chip chip-muted">{env}</span>
        <button disabled={loading} onClick={() => void refresh(true)}>
          {loading ? 'Обновляю…' : 'Обновить'}
        </button>
        <input
          className="pods-search"
          placeholder="фильтр по имени"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="pods-filter">
          <input
            type="checkbox"
            checked={onlyRunning}
            onChange={(e) => setOnlyRunning(e.target.checked)}
          />
          только Running
        </label>
        <span className="settings-note">
          {data ? `обновлено ${new Date(data.fetchedAt).toLocaleTimeString()}` : ''}
        </span>
      </div>

      {error && <div className="banner banner-red">{error}</div>}
      {!data && !error && <div className="settings-note">Запрашиваю поды…</div>}

      {data &&
        groups.map((g) => (
          <div key={g.id ?? '_rest'} className="pods-group">
            <div className="pods-group-title">
              {g.title} <span className="settings-note">· {g.pods.length}</span>
            </div>
            {g.pods.length === 0 ?
              <div className="settings-note">нет подов под маской</div>
            : <table className="pods-table">
                <thead>
                  <tr>
                    <th>имя</th>
                    <th>ready</th>
                    <th>статус</th>
                    <th>рестарты</th>
                    <th>age</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {g.pods.map((p) => (
                    <PodRow
                      key={p.name}
                      pod={p}
                      env={env}
                      workloadId={g.id}
                      fresh={p.name === g.freshest}
                      now={now}
                      cmdOpen={cmdPod === p.name}
                      onToggleCmd={() => setCmdPod(cmdPod === p.name ? null : p.name)}
                    />
                  ))}
                </tbody>
              </table>
            }
          </div>
        ))}
    </div>
  )
}

const byStartDesc = (a: PodInfo, b: PodInfo): number =>
  (b.startedAt ? Date.parse(b.startedAt) : 0) - (a.startedAt ? Date.parse(a.startedAt) : 0)

function PodRow({
  pod,
  env,
  workloadId,
  fresh,
  now,
  cmdOpen,
  onToggleCmd
}: {
  pod: PodInfo
  env: EnvId
  workloadId: string | null
  fresh: boolean
  now: number
  cmdOpen: boolean
  onToggleCmd: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const req = { env, workloadId, pod: pod.name }

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <tr className={fresh ? 'pod-fresh' : ''}>
        <td className="pod-name" title={`контейнеры: ${pod.containers.join(', ')}`}>
          {pod.name}
          {fresh && <span className="chip chip-green pod-badge">свежий</span>}
        </td>
        <td>
          {pod.readyCount}/{pod.totalCount}
        </td>
        <td>
          <span className={`chip ${phaseClass(pod)}`}>{pod.phase}</span>
        </td>
        <td>{pod.restarts}</td>
        <td>{ageOf(pod.createdAt, now)}</td>
        <td className="pod-actions">
          <button
            disabled={busy}
            onClick={() => {
              if (!confirmProd(env, `bash в ${pod.name}`)) return
              void act(() => runKubeSession(() => rpc('kube.bash', req)))
            }}
          >
            Bash
          </button>
          <button
            disabled={busy}
            onClick={() => void act(() => runKubeSession(() => rpc('kube.logs', req)))}
          >
            Логи
          </button>
          <button disabled={busy} onClick={onToggleCmd}>
            Команда…
          </button>
          <button
            title="Скопировать имя пода"
            onClick={() => void navigator.clipboard.writeText(pod.name)}
          >
            ⧉
          </button>
        </td>
      </tr>
      {cmdOpen && (
        <tr>
          <td colSpan={6}>
            <ExecPanel env={env} workloadId={workloadId} pod={pod.name} />
          </td>
        </tr>
      )}
    </>
  )
}

/** One-shot команда в контейнере (FR-K5): вывод панелью, фолбэк в PTY при MFA. */
function ExecPanel({
  env,
  workloadId,
  pod
}: {
  env: EnvId
  workloadId: string | null
  pod: string
}): React.JSX.Element {
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [out, setOut] = useState<{ text: string; code: number | null; ms: number } | null>(null)
  const [failed, setFailed] = useState<{ error: string; needsPty: boolean } | null>(null)

  const run = async (): Promise<void> => {
    if (command.trim().length === 0) return
    if (!confirmProd(env, `${command} в ${pod}`)) return
    setRunning(true)
    setOut(null)
    setFailed(null)
    try {
      const res = await rpc('kube.exec', { env, workloadId, pod, command })
      if (res.ok) {
        const text = [res.stdout, res.stderr].filter((s) => s.length > 0).join('\n')
        setOut({ text: text || '(пустой вывод)', code: res.code, ms: res.ms })
      } else {
        setFailed({ error: res.error, needsPty: res.needsPty === true })
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="exec">
      <div className="exec-row">
        <input
          className="exec-input"
          placeholder="команда в контейнере (sh -lc …)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
        />
        <button className="primary" disabled={running} onClick={() => void run()}>
          {running ? '…' : 'Выполнить'}
        </button>
        <button
          disabled={running || command.trim().length === 0}
          title="Выполнить видимым PTY-табом (нужно при per-session MFA)"
          onClick={() => {
            if (!confirmProd(env, `${command} в ${pod}`)) return
            void runKubeSession(() => rpc('kube.execPty', { env, workloadId, pod, command }))
          }}
        >
          В терминале
        </button>
      </div>
      {out && (
        <>
          <div className="settings-note">
            exit {out.code ?? '—'} · {out.ms} мс
          </div>
          <pre className="exec-out">{out.text}</pre>
        </>
      )}
      {failed && (
        <div className="banner banner-red">
          {failed.error}
          {failed.needsPty && ' — повтори кнопкой «В терминале»: команда требует MFA.'}
        </div>
      )}
    </div>
  )
}
