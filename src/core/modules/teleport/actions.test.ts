import { describe, expect, it, vi } from 'vitest'
import type { ProxyView } from '../../domain/proxy'
import type { SessionInfo } from '../../domain/session'
import type { ActionContext, ActionResult } from '../../services/ActionRegistry'
import type { KubeSessionMeta, KubeSessionResult } from '../../services/KubeService'
import { teleportActions, type ActionDeps } from './actions'

const session = (id: string): SessionInfo => ({
  id,
  title: 'таб',
  state: 'running',
  exitCode: null,
  startedAt: 0,
  paused: false
})

const meta = (sessionId: string): KubeSessionMeta => ({
  sessionId,
  kind: 'bash',
  env: 'dev',
  workloadId: 'api',
  pod: 'api-web-1',
  container: 'api'
})

const proxyView = (over: Partial<ProxyView> = {}): ProxyView => ({
  presetId: 'db-dev',
  label: 'dev',
  env: 'dev',
  port: 6432,
  dangerous: false,
  on: false,
  state: 'off',
  sessionId: null,
  attempts: 0,
  error: null,
  ...over
})

const ctx = (confirmed: string[] = [], param = ''): ActionContext => ({
  param,
  confirmed: (key) => confirmed.includes(key)
})

function deps(over: Partial<ActionDeps> = {}): ActionDeps {
  return {
    auth: { login: () => session('login') },
    proxies: {
      list: () => [proxyView()],
      start: async () => ({ ok: true }),
      stop: async () => undefined
    },
    kube: {
      state: () => ({
        env: 'dev',
        namespace: 'apps',
        cluster: 'dev-cluster',
        currentCluster: 'dev-cluster',
        switching: false,
        workloads: [{ id: 'api', title: 'api' }]
      }),
      setEnv: vi.fn(),
      bash: async () => ({ ok: false, error: 'нет пода' }),
      logs: async () => ({ ok: false, error: 'нет пода' }),
      execPty: async () => ({ ok: false, error: 'нет пода' })
    },
    sql: {
      state: () => ({
        targets: [],
        dumps: [],
        statementTimeoutMs: 30_000,
        maxRows: 1000
      }),
      openPsql: () => ({ ok: false, reason: 'no-tunnel', error: 'Туннель не поднят' })
    },
    dumps: { start: async () => ({ ok: false, reason: 'no-tunnel', error: 'Туннель не поднят' }) },
    ...over
  }
}

const find = (list: ReturnType<typeof teleportActions>, id: string): (typeof list)[number] => {
  const action = list.find((a) => a.id === id)
  if (!action) throw new Error(`нет действия ${id}`)
  return action
}

describe('действия модуля teleport', () => {
  it('подпись тумблера говорит, что произойдёт', () => {
    const off = teleportActions(deps())
    expect(find(off, 'proxy.toggle:db-dev').title).toBe('DB-прокси: включить dev')

    const on = teleportActions(
      deps({
        proxies: {
          list: () => [proxyView({ on: true, state: 'healthy' })],
          start: async () => ({ ok: true }),
          stop: async () => undefined
        }
      })
    )
    expect(find(on, 'proxy.toggle:db-dev').title).toBe('DB-прокси: выключить dev')
  })

  it('включённую прокси действие выключает, а не пытается поднять снова', async () => {
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(async () => ({ ok: true }) as const)
    const list = teleportActions(
      deps({
        proxies: { list: () => [proxyView({ on: true, state: 'healthy' })], start, stop }
      })
    )
    await expect(find(list, 'proxy.toggle:db-dev').run(ctx())).resolves.toEqual({ ok: true })
    expect(stop).toHaveBeenCalledWith('db-dev')
    expect(start).not.toHaveBeenCalled()
  })

  it('боевую базу без подтверждения не включает (US-14)', async () => {
    const start = vi.fn(async () => ({ ok: true }) as const)
    const list = teleportActions(
      deps({
        proxies: {
          list: () => [proxyView({ presetId: 'db-prod', label: 'prod', dangerous: true })],
          start,
          stop: async () => undefined
        }
      })
    )
    const action = find(list, 'proxy.toggle:db-prod')
    expect(action.dangerous).toBe(true)
    const asked = (await action.run(ctx())) as Extract<ActionResult, { reason: 'needs-confirm' }>
    expect(asked).toMatchObject({ reason: 'needs-confirm', confirmKey: 'prod' })
    expect(start).not.toHaveBeenCalled()

    await action.run(ctx(['prod']))
    expect(start).toHaveBeenCalledWith('db-prod', {})
  })

  it('конфликт общего порта спрашивает отдельно и только потом форсит', async () => {
    const start = vi.fn(async (_id: string, opts: { force?: boolean } = {}) =>
      opts.force ?
        ({ ok: true } as const)
      : ({ ok: false, reason: 'conflict', conflictPresetId: 'db-stage', conflictLabel: 'stage' } as const)
    )
    const list = teleportActions(
      deps({ proxies: { list: () => [proxyView()], start, stop: async () => undefined } })
    )
    const action = find(list, 'proxy.toggle:db-dev')

    const asked = await action.run(ctx())
    expect(asked).toMatchObject({ reason: 'needs-confirm', confirmKey: 'conflict' })
    expect(asked).toMatchObject({ error: expect.stringContaining('stage') })

    await expect(action.run(ctx(['conflict']))).resolves.toEqual({ ok: true })
    expect(start).toHaveBeenLastCalledWith('db-dev', { force: true })
  })

  it('занятый посторонним порт возвращает подсказку lsof', async () => {
    const list = teleportActions(
      deps({
        proxies: {
          list: () => [proxyView()],
          start: async () => ({ ok: false, reason: 'busy-port', hint: 'lsof: PID 123' }),
          stop: async () => undefined
        }
      })
    )
    await expect(find(list, 'proxy.toggle:db-dev').run(ctx())).resolves.toEqual({
      ok: false,
      reason: 'failed',
      error: 'lsof: PID 123'
    })
  })

  it('bash на prod спрашивает подтверждение, логи — нет', async () => {
    const bash = vi.fn(async () => ({ ok: false, error: 'нет пода' }) as const)
    const logs = vi.fn(async () => ({ ok: false, error: 'нет пода' }) as const)
    const base = deps()
    const list = teleportActions({
      ...base,
      kube: {
        ...base.kube,
        state: () => ({ ...base.kube.state(), env: 'prod', cluster: 'prod-cluster' }),
        bash,
        logs
      }
    })

    await expect(find(list, 'kube.bash:api').run(ctx())).resolves.toMatchObject({
      reason: 'needs-confirm',
      confirmKey: 'prod'
    })
    expect(bash).not.toHaveBeenCalled()

    await find(list, 'kube.logs:api').run(ctx())
    expect(logs).toHaveBeenCalledWith({ env: 'prod', workloadId: 'api' })
  })

  it('успех kube-действия показывает таб сессии', async () => {
    const base = deps()
    const list = teleportActions({
      ...base,
      kube: {
        ...base.kube,
        bash: async (): Promise<KubeSessionResult> => ({
          ok: true,
          session: session('s1'),
          meta: meta('s1')
        })
      }
    })
    await expect(find(list, 'kube.bash:api').run(ctx())).resolves.toEqual({
      ok: true,
      reveal: { view: 'session', sessionId: 's1' }
    })
  })

  it('«нужен перелогин» доезжает до UI', async () => {
    const base = deps()
    const list = teleportActions({
      ...base,
      kube: {
        ...base.kube,
        logs: async () => ({ ok: false, error: 'cert has expired', needsLogin: true })
      }
    })
    await expect(find(list, 'kube.logs:api').run(ctx())).resolves.toEqual({
      ok: false,
      reason: 'failed',
      error: 'cert has expired',
      needsLogin: true
    })
  })

  it('одноразовая команда уходит в контейнер как есть', async () => {
    const execPty = vi.fn(
      async (): Promise<KubeSessionResult> => ({
        ok: true,
        session: session('s2'),
        meta: meta('s2')
      })
    )
    const base = deps()
    const list = teleportActions({ ...base, kube: { ...base.kube, execPty } })
    const action = find(list, 'kube.exec:api')
    expect(action.param?.label).toContain('api')
    await action.run(ctx([], 'ls -la /app'))
    expect(execPty).toHaveBeenCalledWith({ env: 'dev', workloadId: 'api', command: 'ls -la /app' })
  })

  it('SQL-действия появляются на каждый пресет базы и пресет дампа', () => {
    const list = teleportActions(
      deps({
        sql: {
          state: () => ({
            targets: [
              {
                presetId: 'db-dev',
                label: 'dev',
                env: 'dev',
                dbUser: 'app',
                dbName: 'dev',
                port: 6432,
                dangerous: false
              }
            ],
            dumps: [{ id: 'dump', title: 'pg_dump' }],
            statementTimeoutMs: 30_000,
            maxRows: 1000
          }),
          openPsql: () => ({ ok: true, session: session('s3') })
        }
      })
    )
    expect(list.map((a) => a.id)).toEqual(
      expect.arrayContaining(['sql.open:db-dev', 'sql.psql:db-dev', 'sql.dump:dump:db-dev'])
    )
    expect(find(list, 'sql.open:db-dev').run(ctx())).toEqual({
      ok: true,
      reveal: { view: 'sql', presetId: 'db-dev' }
    })
  })

  it('отказ от диалога сохранения дампа — не ошибка', async () => {
    const list = teleportActions(
      deps({
        sql: {
          state: () => ({
            targets: [
              {
                presetId: 'db-dev',
                label: 'dev',
                env: 'dev',
                dbUser: 'app',
                dbName: 'dev',
                port: 6432,
                dangerous: false
              }
            ],
            dumps: [{ id: 'dump', title: 'pg_dump' }],
            statementTimeoutMs: 30_000,
            maxRows: 1000
          }),
          openPsql: () => ({ ok: true, session: session('s3') })
        },
        dumps: { start: async () => ({ ok: false, reason: 'canceled', error: null }) }
      })
    )
    await expect(find(list, 'sql.dump:dump:db-dev').run(ctx())).resolves.toEqual({ ok: true })
  })
})
