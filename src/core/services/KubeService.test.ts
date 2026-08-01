import { describe, expect, it } from 'vitest'
import {
  KUBE_EXPIRED_STDERR,
  KUBE_LOGIN_EXPIRED_STDERR,
  KUBE_NOW,
  PODS_JSON
} from '../modules/teleport/__fixtures__/kube'
import { TshClient } from '../modules/teleport/TshClient'
import type { KubeConfig, TeleportConfig, TshStatus } from '../modules/teleport/types'
import { noopLogger } from '../ports/Logger'
import type { ProcessRunner, RunResult } from '../ports/ProcessRunner'
import type { PtyFactory, PtyHandle } from '../ports/PtyFactory'
import { KubeService } from './KubeService'
import { SessionManager } from './SessionManager'

const TELEPORT: TeleportConfig = {
  proxy: 'teleport.example.com:443',
  user: 'user@example.com',
  cluster: 'teleport.example.com',
  tshPath: '/usr/local/bin/tsh',
  mfaMode: 'otp'
}

const KUBE: KubeConfig = {
  namespace: 'apps',
  clusters: { dev: 'dev-k8s-cluster', stage: 'stage-k8s-cluster', prod: 'prod-k8s-cluster' },
  workloads: [
    {
      id: 'api',
      title: 'api',
      podPrefix: 'api-web-',
      podExclude: [],
      container: 'api',
      containerAutoDiscover: false
    },
    {
      id: 'auth',
      title: 'auth',
      podPrefix: 'auth-web-',
      podExclude: ['-worker-', '-cron-'],
      container: 'auth',
      containerAutoDiscover: true
    }
  ],
  logsTail: 500
}

class FakePty implements PtyHandle {
  private exitCb: ((e: { exitCode: number | null }) => void) | null = null
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {
    this.exitCb?.({ exitCode: 0 })
  }
  onData(): void {}
  onExit(cb: (e: { exitCode: number | null }) => void): void {
    this.exitCb = cb
  }
}

interface Call {
  args: string[]
}

/** Фейковый tsh: очередь ответов по первому аргументу команды. */
function setup(
  opts: {
    kubeCluster?: string | null
    pods?: RunResult
    login?: RunResult
    /** null — статус ещё не приезжал (холодный старт). */
    status?: TshStatus | null
    kube?: KubeConfig
  } = {}
) {
  const calls: Call[] = []
  let status: TshStatus = {
    loggedIn: true,
    username: 'user@example.com',
    cluster: 'teleport.example.com',
    kubeCluster: opts.kubeCluster === undefined ? 'dev-k8s-cluster' : opts.kubeCluster,
    validUntil: '2026-07-31T00:00:00+04:00'
  }
  let refreshes = 0

  const runner: ProcessRunner = {
    run: async (_cmd, args) => {
      calls.push({ args })
      if (args[0] === 'kube' && args[1] === 'login') {
        const res = opts.login ?? { stdout: '', stderr: '', code: 0 }
        if (res.code === 0) {
          const cluster = args[args.length - 1] as string
          status = { ...status, kubeCluster: cluster }
          if (cached) cached = status
        }
        return res
      }
      if (args[0] === 'kubectl' && args[1] === 'get') {
        return opts.pods ?? { stdout: PODS_JSON, stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    }
  }

  const spawns: { cmd: string; args: string[]; title: string }[] = []
  const ptyFactory: PtyFactory = {
    spawn: (spec) => {
      spawns.push({ cmd: spec.cmd, args: spec.args, title: spec.title })
      return new FakePty()
    }
  }

  const sessions = new SessionManager(ptyFactory, noopLogger)
  const tsh = new TshClient(runner, () => TELEPORT, noopLogger)
  let cached: TshStatus | null = opts.status === undefined ? status : opts.status
  const auth = {
    getCached: () => cached,
    refreshStatus: async () => {
      refreshes += 1
      cached = status
      return status
    }
  }
  let now = KUBE_NOW
  const kube = new KubeService(
    () => opts.kube ?? KUBE,
    tsh,
    sessions,
    () => ({ feed: () => {} }),
    auth,
    noopLogger,
    { now: () => now }
  )
  return {
    kube,
    calls,
    spawns,
    sessions,
    advance: (ms: number) => (now += ms),
    stats: () => ({ refreshes })
  }
}

const argsOf = (calls: Call[], head: string): string[][] =>
  calls.filter((c) => c.args[0] === head).map((c) => c.args)

describe('KubeService.ensureCluster', () => {
  it('кластер уже активен → kube login не зовём', async () => {
    const { kube, calls } = setup({ kubeCluster: 'dev-k8s-cluster' })
    expect(await kube.ensureCluster('dev')).toEqual({ ok: true, cluster: 'dev-k8s-cluster' })
    expect(argsOf(calls, 'kube')).toEqual([])
  })

  it('kube не настроен → в tsh не идём вообще (иначе баннер «kube-cluster name is required»)', async () => {
    const empty: KubeConfig = { ...KUBE, namespace: '', clusters: { dev: '', stage: '', prod: '' } }
    const { kube, calls } = setup({ kube: empty })
    expect(await kube.ensureCluster('dev')).toEqual({
      ok: false,
      error: 'Kubernetes не настроен: в конфиге пуст kube.namespace.'
    })
    expect(await kube.listPods('dev')).toMatchObject({ ok: false })
    expect(calls).toEqual([])
  })

  it('namespace есть, а кластера окружения нет → ошибка называет пустое поле', async () => {
    const noCluster: KubeConfig = { ...KUBE, clusters: { ...KUBE.clusters, prod: '' } }
    const { kube, calls } = setup({ kube: noCluster })
    expect(await kube.ensureCluster('prod')).toEqual({
      ok: false,
      error: 'Kubernetes не настроен: в конфиге пуст kube.clusters.prod.'
    })
    expect(calls).toEqual([])
  })

  it('статуса ещё нет (холодный старт) → сначала спрашиваем tsh status, а не логинимся', async () => {
    const { kube, calls, stats } = setup({ status: null, kubeCluster: 'dev-k8s-cluster' })
    expect(await kube.ensureCluster('dev')).toEqual({ ok: true, cluster: 'dev-k8s-cluster' })
    expect(argsOf(calls, 'kube')).toEqual([])
    expect(stats().refreshes).toBe(1)
  })

  it('несовпадение → прозрачный kube login с --mfa-mode=otp + refresh статуса', async () => {
    const { kube, calls, stats } = setup({ kubeCluster: 'stage-k8s-cluster' })
    const res = await kube.ensureCluster('dev')
    expect(res).toEqual({ ok: true, cluster: 'dev-k8s-cluster' })
    expect(argsOf(calls, 'kube')).toEqual([
      ['kube', 'login', '--mfa-mode=otp', 'dev-k8s-cluster']
    ])
    expect(stats().refreshes).toBe(1)
  })

  it('параллельные действия логинятся в кластер один раз (очередь)', async () => {
    const { kube, calls } = setup({ kubeCluster: 'stage-k8s-cluster' })
    await Promise.all([kube.ensureCluster('dev'), kube.ensureCluster('dev'), kube.ensureCluster('dev')])
    expect(argsOf(calls, 'kube')).toHaveLength(1)
  })

  it('kube login упал с «session expired» → ошибка с needsLogin', async () => {
    const { kube } = setup({
      kubeCluster: 'stage-k8s-cluster',
      login: { stdout: '', stderr: KUBE_EXPIRED_STDERR, code: 1 }
    })
    const res = await kube.ensureCluster('dev')
    expect(res).toMatchObject({ ok: false, needsLogin: true })
  })

  it('живой stderr «cert has expired»: ANSI снят, needsLogin выставлен', async () => {
    const { kube } = setup({
      kubeCluster: 'stage-k8s-cluster',
      login: { stdout: '', stderr: KUBE_LOGIN_EXPIRED_STDERR, code: 1 }
    })
    const res = await kube.ensureCluster('dev')
    expect(res).toEqual({
      ok: false,
      error: 'ERROR: ssh: cert has expired',
      needsLogin: true
    })
  })

  it('состояние отдаётся событием: switching на время логина', async () => {
    const { kube } = setup({ kubeCluster: 'stage-k8s-cluster' })
    const switching: boolean[] = []
    kube.events.on('state', ({ view }) => switching.push(view.switching))
    await kube.ensureCluster('dev')
    expect(switching).toEqual([true, false])
  })
})

describe('KubeService.listPods', () => {
  it('поды с проставленным workloadId + кластер в ответе', async () => {
    const { kube } = setup()
    const res = await kube.listPods('dev')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.pods).toHaveLength(8)
    expect(res.cluster).toBe('dev-k8s-cluster')
    expect(res.pods.filter((p) => p.workloadId === 'api')).toHaveLength(2)
  })

  it('свежайший под workload’а считается в ядре, а не в UI', async () => {
    const { kube } = setup()
    const res = await kube.listPods('dev')
    if (!res.ok) throw new Error('не разобрались')
    expect(res.freshest).toEqual({
      api: 'api-web-6d5c9f7b8-xpgt9',
      auth: 'auth-web-5bd75f8d6-f6zw7'
    })
  })

  it('kubectl упал по протухшей сессии → needsLogin, а не «подов нет»', async () => {
    const { kube } = setup({ pods: { stdout: '', stderr: KUBE_EXPIRED_STDERR, code: 1 } })
    const res = await kube.listPods('dev')
    expect(res).toMatchObject({ ok: false, needsLogin: true })
  })
})

describe('KubeService: кэш списка подов', () => {
  const getPods = (calls: Call[]): string[][] =>
    calls.filter((c) => c.args[1] === 'get').map((c) => c.args)

  it('повторный запрос в пределах TTL — из кэша (get pods ~2 с на живом namespace)', async () => {
    const { kube, calls } = setup()
    await kube.listPods('dev')
    await kube.listPods('dev')
    await kube.bash({ env: 'dev', workloadId: 'api' })
    expect(getPods(calls)).toHaveLength(1)
  })

  it('устаревший кэш и «Обновить» (force) идут в кластер', async () => {
    const { kube, calls, advance } = setup()
    await kube.listPods('dev')
    await kube.listPods('dev', { force: true })
    advance(20_000)
    await kube.listPods('dev')
    expect(getPods(calls)).toHaveLength(3)
  })

  it('параллельные запросы делят один вызов', async () => {
    const { kube, calls } = setup()
    await Promise.all([kube.listPods('dev'), kube.listPods('dev'), kube.listPods('dev')])
    expect(getPods(calls)).toHaveLength(1)
  })

  it('кэш на окружение свой', async () => {
    const { kube, calls } = setup()
    await kube.listPods('dev')
    await kube.listPods('stage')
    expect(getPods(calls)).toHaveLength(2)
  })

  it('kube-сессия умерла → список сбрасывается (под мог уехать в rollout)', async () => {
    const { kube, calls, sessions } = setup()
    const res = await kube.bash({ env: 'dev', workloadId: 'api' })
    if (!res.ok) throw new Error('не стартовала')
    expect(getPods(calls)).toHaveLength(1)

    sessions.stop(res.session.id)
    await kube.listPods('dev')
    expect(getPods(calls)).toHaveLength(2)
  })
})

describe('KubeService.bash / logs (FR-K4, FR-K6)', () => {
  it('bash в свежайший под api: kube login не нужен, команда дословная', async () => {
    const { kube, spawns } = setup({ kubeCluster: 'dev-k8s-cluster' })
    const res = await kube.bash({ env: 'dev', workloadId: 'api' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.meta.pod).toBe('api-web-6d5c9f7b8-xpgt9')
    expect(res.meta.container).toBe('api')
    expect(spawns[0]?.args).toEqual([
      'kubectl',
      'exec',
      '-it',
      'api-web-6d5c9f7b8-xpgt9',
      '-n',
      'apps',
      '-c',
      'api',
      '--',
      'bash'
    ])
    expect(spawns[0]?.title).toBe('bash: api @ xpgt9 (dev)')
  })

  it('bash на другом окружении сначала переключает кластер', async () => {
    const { kube, calls } = setup({ kubeCluster: 'dev-k8s-cluster' })
    await kube.bash({ env: 'prod', workloadId: 'api' })
    expect(argsOf(calls, 'kube')[0]).toEqual([
      'kube',
      'login',
      '--mfa-mode=otp',
      'prod-k8s-cluster'
    ])
  })

  it('нет готового пода → честная ошибка вместо спавна', async () => {
    const { kube, spawns } = setup()
    const res = await kube.bash({ env: 'dev', workloadId: 'нет-такого' })
    expect(res.ok).toBe(false)
    expect(spawns).toHaveLength(0)
  })

  it('под указан вручную (US-05): берём его, контейнер — из spec', async () => {
    const { kube } = setup()
    const res = await kube.bash({
      env: 'dev',
      workloadId: null,
      pod: 'portal-7854d47c9-dwbkv'
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.meta).toMatchObject({
      pod: 'portal-7854d47c9-dwbkv',
      container: 'portal'
    })
  })

  it('исчезнувший под (список устарел) → ошибка, а не exec в пустоту', async () => {
    const { kube } = setup()
    const res = await kube.bash({ env: 'dev', workloadId: 'api', pod: 'api-старый' })
    expect(res).toMatchObject({ ok: false })
  })

  it('логи: --tail из конфига + --follow, sidecar не выбран у auth', async () => {
    const { kube, spawns } = setup()
    const res = await kube.logs({ env: 'dev', workloadId: 'auth' })
    expect(res.ok).toBe(true)
    expect(spawns[0]?.args).toEqual([
      'kubectl',
      'logs',
      'auth-web-5bd75f8d6-f6zw7',
      '-n',
      'apps',
      '-c',
      'auth',
      '--tail=500',
      '--follow'
    ])
  })

  it('kube-привязка сессии живёт до её удаления из реестра', async () => {
    const { kube, sessions } = setup()
    const events: (string | null)[] = []
    kube.events.on('session', ({ meta }) => events.push(meta?.pod ?? null))
    const res = await kube.bash({ env: 'dev', workloadId: 'api' })
    if (!res.ok) throw new Error('не стартовала')
    expect(kube.sessionMetas()).toHaveLength(1)

    sessions.remove(res.session.id) // живую не удалит — сессия ещё alive
    expect(kube.sessionMetas()).toHaveLength(1)

    sessions.stop(res.session.id) // exit → таб можно закрыть, привязка уходит с ним
    sessions.remove(res.session.id)
    expect(kube.sessionMetas()).toHaveLength(0)
    expect(events).toEqual(['api-web-6d5c9f7b8-xpgt9', null])
  })
})

describe('KubeService.exec (FR-K5)', () => {
  it('one-shot: sh -lc, ненулевой exit команды — валидный результат', async () => {
    const calls: Call[] = []
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        calls.push({ args })
        if (args[0] === 'kubectl' && args[1] === 'get') {
          return { stdout: PODS_JSON, stderr: '', code: 0 }
        }
        if (args[0] === 'kube') return { stdout: '', stderr: '', code: 0 }
        return { stdout: 'нет такого файла', stderr: 'ls: no such file', code: 2 }
      }
    }
    const sessions = new SessionManager({ spawn: () => new FakePty() }, noopLogger)
    const tsh = new TshClient(runner, () => TELEPORT, noopLogger)
    const kube = new KubeService(
      () => KUBE,
      tsh,
      sessions,
      () => ({ feed: () => {} }),
      { getCached: () => null, refreshStatus: async () => null },
      noopLogger
    )
    // kubeCluster null ⇒ будет kube login — он в этом фейке возвращает code 0
    const res = await kube.exec({ env: 'dev', workloadId: 'api', command: 'ls /nope' })
    expect(res).toMatchObject({ ok: true, code: 2, stdout: 'нет такого файла' })
    const exec = calls.find((c) => c.args[1] === 'exec')?.args
    expect(exec).toEqual([
      'kubectl',
      'exec',
      'api-web-6d5c9f7b8-xpgt9',
      '-n',
      'apps',
      '-c',
      'api',
      '--',
      'sh',
      '-lc',
      'ls /nope'
    ])
  })

  it('per-session MFA в stderr → needsPty (фолбэк в терминал)', async () => {
    const runner: ProcessRunner = {
      run: async (_cmd, args) => {
        if (args[0] === 'kubectl' && args[1] === 'get') {
          return { stdout: PODS_JSON, stderr: '', code: 0 }
        }
        if (args[0] === 'kubectl' && args[1] === 'exec') {
          return { stdout: '', stderr: 'ERROR: MFA is required for this operation', code: 1 }
        }
        return { stdout: '', stderr: '', code: 0 }
      }
    }
    const sessions = new SessionManager({ spawn: () => new FakePty() }, noopLogger)
    const tsh = new TshClient(runner, () => TELEPORT, noopLogger)
    const kube = new KubeService(
      () => KUBE,
      tsh,
      sessions,
      () => ({ feed: () => {} }),
      {
        getCached: () => ({
          loggedIn: true,
          username: null,
          cluster: null,
          kubeCluster: 'dev-k8s-cluster',
          validUntil: null
        }),
        refreshStatus: async () => null
      },
      noopLogger
    )
    const res = await kube.exec({ env: 'dev', workloadId: 'api', command: 'echo hi' })
    expect(res).toMatchObject({ ok: false, needsPty: true })
  })
})
