import type { SessionInfo } from '../../domain/session'
import type { ProxyView } from '../../domain/proxy'
import { askConfirm, type Action, type ActionResult } from '../../services/ActionRegistry'
import type { KubeSessionResult, KubeStateView } from '../../services/KubeService'
import type { ProxyStartResult } from '../../services/ProxySupervisor'
import type { SqlSessionResult, SqlStateView } from '../../services/SqlService'
import type { EnvId } from './types'
import { ENV_IDS } from './types'

/**
 * Действия модуля Teleport (ADR-0006: модуль вносит contribution в реестр ядра).
 * Здесь же живут все вопросы пользователю — prod-guard и переключение общего
 * порта: до M4 они были продублированы в renderer и в трее и норовили разойтись.
 *
 * Зависимости описаны структурно, а не классами сервисов: так провайдер
 * тестируется без половины приложения.
 */
export interface ActionDeps {
  auth: { login(): SessionInfo }
  proxies: {
    list(): ProxyView[]
    start(presetId: string, opts?: { force?: boolean }): Promise<ProxyStartResult>
    stop(presetId: string): Promise<void>
  }
  kube: {
    state(): KubeStateView
    setEnv(env: EnvId): unknown
    bash(req: { env: EnvId; workloadId: string | null }): Promise<KubeSessionResult>
    logs(req: { env: EnvId; workloadId: string | null }): Promise<KubeSessionResult>
    execPty(req: {
      env: EnvId
      workloadId: string | null
      command: string
    }): Promise<KubeSessionResult>
  }
  sql: {
    state(): SqlStateView
    openPsql(presetId: string): SqlSessionResult
  }
  /** Дамп запускается через main: файл выбирается нативным диалогом (FR-Q5). */
  dumps: {
    start(req: {
      dumpId: string
      presetId: string
    }): Promise<{ ok: true; session: SessionInfo } | { ok: false; reason: string; error: string | null }>
  }
}

/** Общий разбор результата kube-действия: успех — таб в фокус. */
const fromSession = (res: KubeSessionResult | SqlSessionResult): ActionResult =>
  res.ok ?
    { ok: true, reveal: { view: 'session', sessionId: res.session.id } }
  : {
      ok: false,
      reason: 'failed',
      error: res.error,
      ...('needsLogin' in res && res.needsLogin ? { needsLogin: true } : {})
    }

export function teleportActions(deps: ActionDeps): Action[] {
  return [
    ...authActions(deps),
    ...proxyActions(deps),
    ...kubeActions(deps),
    ...sqlActions(deps)
  ]
}

function authActions({ auth }: ActionDeps): Action[] {
  return [
    {
      id: 'auth.login',
      title: 'Teleport: перелогин',
      group: 'Teleport',
      keywords: 'login relogin вход авторизация серт',
      run: () => {
        const session = auth.login()
        return { ok: true, reveal: { view: 'session', sessionId: session.id } }
      }
    }
  ]
}

/**
 * Тумблер прокси одним действием: подпись говорит, что произойдёт, поэтому
 * «включить» и «выключить» не нужны отдельными строками палитры.
 */
function proxyActions({ proxies }: ActionDeps): Action[] {
  return proxies.list().map((view): Action => {
    const on = view.on
    return {
      id: `proxy.toggle:${view.presetId}`,
      title: `DB-прокси: ${on ? 'выключить' : 'включить'} ${view.label}`,
      group: 'DB-прокси',
      keywords: `proxy tunnel туннель ${view.env} порт ${view.port}`,
      dangerous: view.dangerous,
      run: async (ctx) => {
        if (on) {
          await proxies.stop(view.presetId)
          return { ok: true }
        }
        if (view.dangerous && !ctx.confirmed('prod')) {
          return askConfirm('prod', `Включить прокси «${view.label}» (PROD)?`)
        }
        return startProxy(proxies, view, ctx.confirmed('conflict'))
      }
    }
  })
}

/**
 * Включение с двумя возможными вопросами: боевая база и общий порт (FR-D4).
 * Ключи вопросов разные — «да» на prod не считается согласием выключить чужой
 * туннель.
 */
async function startProxy(
  proxies: ActionDeps['proxies'],
  view: ProxyView,
  forceAllowed: boolean
): Promise<ActionResult> {
  const res = await proxies.start(view.presetId, forceAllowed ? { force: true } : {})
  if (res.ok) return { ok: true }
  if (res.reason === 'conflict') {
    if (!forceAllowed) {
      return askConfirm(
        'conflict',
        `Порт ${view.port} общий: выключить «${res.conflictLabel}» и включить «${view.label}»?`
      )
    }
    return { ok: false, reason: 'failed', error: `Порт ${view.port} занят другим пресетом` }
  }
  if (res.reason === 'busy-port') return { ok: false, reason: 'failed', error: res.hint }
  return { ok: false, reason: 'failed', error: `Пресет «${view.presetId}» не найден` }
}

function kubeActions({ kube }: ActionDeps): Action[] {
  const state = kube.state()
  const env = state.env
  const prod = env === 'prod'
  const actions: Action[] = [
    {
      id: 'kube.pods',
      title: 'Поды: открыть список',
      group: 'Kubernetes',
      keywords: 'pods список подов kubectl',
      run: () => ({ ok: true, reveal: { view: 'pods' } })
    }
  ]

  for (const id of ENV_IDS) {
    actions.push({
      id: `kube.env:${id}`,
      title: `Kube: окружение ${id}${id === env ? ' (текущее)' : ''}`,
      group: 'Kubernetes',
      keywords: `environment окружение кластер ${state.namespace}`,
      dangerous: id === 'prod',
      run: () => {
        kube.setEnv(id)
        return { ok: true, reveal: { view: 'pods' } }
      }
    })
  }

  for (const w of state.workloads) {
    actions.push({
      id: `kube.bash:${w.id}`,
      title: `Bash → ${w.title} (${env})`,
      group: 'Kubernetes',
      keywords: `shell exec терминал под ${w.id}`,
      dangerous: prod,
      run: async (ctx) => {
        if (prod && !ctx.confirmed('prod')) {
          return askConfirm('prod', `PROD: bash в свежайший под «${w.title}». Продолжить?`)
        }
        return fromSession(await kube.bash({ env, workloadId: w.id }))
      }
    })
    actions.push({
      id: `kube.logs:${w.id}`,
      title: `Логи → ${w.title} (${env})`,
      group: 'Kubernetes',
      keywords: `logs follow хвост ${w.id}`,
      // логи read-only: подтверждения на prod не требуют (docs/02 §5)
      run: async () => fromSession(await kube.logs({ env, workloadId: w.id }))
    })
    actions.push({
      id: `kube.exec:${w.id}`,
      title: `Команда в ${w.title} (${env})…`,
      group: 'Kubernetes',
      keywords: `exec command one-shot выполнить ${w.id}`,
      dangerous: prod,
      param: { label: `Команда для sh -lc в «${w.title}»`, placeholder: 'ls -la /app' },
      run: async (ctx) => {
        if (prod && !ctx.confirmed('prod')) {
          return askConfirm('prod', `PROD: «${ctx.param}» в поде «${w.title}». Продолжить?`)
        }
        return fromSession(await kube.execPty({ env, workloadId: w.id, command: ctx.param }))
      }
    })
  }
  return actions
}

function sqlActions({ sql, dumps }: ActionDeps): Action[] {
  const state = sql.state()
  const actions: Action[] = []
  for (const target of state.targets) {
    actions.push({
      id: `sql.open:${target.presetId}`,
      title: `SQL: консоль ${target.label}`,
      group: 'SQL',
      keywords: `query запрос база ${target.env} ${target.dbName}`,
      dangerous: target.dangerous,
      run: () => ({ ok: true, reveal: { view: 'sql', presetId: target.presetId } })
    })
    actions.push({
      id: `sql.psql:${target.presetId}`,
      title: `psql в терминале: ${target.label}`,
      group: 'SQL',
      keywords: `psql консоль клиент ${target.env}`,
      dangerous: target.dangerous,
      run: () => fromSession(sql.openPsql(target.presetId))
    })
    for (const dump of state.dumps) {
      actions.push({
        id: `sql.dump:${dump.id}:${target.presetId}`,
        title: `${dump.title} → ${target.label}`,
        group: 'SQL',
        keywords: `dump pg_dump бэкап выгрузка ${target.env}`,
        dangerous: target.dangerous,
        run: async (ctx) => {
          if (target.dangerous && !ctx.confirmed('prod')) {
            return askConfirm('prod', `PROD: ${dump.title} базы «${target.label}». Продолжить?`)
          }
          const res = await dumps.start({ dumpId: dump.id, presetId: target.presetId })
          if (res.ok) return { ok: true, reveal: { view: 'session', sessionId: res.session.id } }
          // отказ от диалога сохранения — не ошибка, показывать нечего
          if (res.reason === 'canceled') return { ok: true }
          return { ok: false, reason: 'failed', error: res.error ?? 'Дамп не запустился' }
        }
      })
    }
  }
  return actions
}
