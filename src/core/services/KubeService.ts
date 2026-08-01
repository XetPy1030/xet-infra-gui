import type { SessionInfo } from '../domain/session'
import { isAuthError, isMfaError } from '../modules/teleport/prompts'
import { defaultContainer, parsePods, resolveContainer, selectFreshest } from '../modules/teleport/pods'
import type { KubeTarget, TshClient } from '../modules/teleport/TshClient'
import type { EnvId, KubeConfig, KubeWorkload, PodInfo, TshStatus } from '../modules/teleport/types'
import type { Clock } from '../ports/Clock'
import { systemClock } from '../ports/Clock'
import type { Logger } from '../ports/Logger'
import { stripAnsi } from '../util/ansi'
import { Emitter } from '../util/Emitter'
import type { PipelineFactory, SessionManager } from './SessionManager'

/** Состояние kube-раздела для UI и трея. */
export interface KubeStateView {
  env: EnvId
  namespace: string
  /** Кластер, настроенный на выбранное окружение. */
  cluster: string
  /** Активный kube-контекст по `tsh status`; отличается до kube login. */
  currentCluster: string | null
  /** Идёт `tsh kube login` — UI показывает спиннер (US-12). */
  switching: boolean
  workloads: { id: string; title: string }[]
}

/** Привязка PTY-сессии к kube-цели: нужна для «переподключиться к свежему поду». */
export interface KubeSessionMeta {
  sessionId: string
  kind: 'bash' | 'logs' | 'exec'
  env: EnvId
  /** null — под вне масок конфига (выбран вручную из группы «прочее»). */
  workloadId: string | null
  pod: string
  container: string
}

export interface KubeFail {
  ok: false
  error: string
  /** Ошибка пахнет протухшей сессией (docs/04 §6) — UI зовёт перелогин. */
  needsLogin?: boolean
}

export interface PodsView {
  pods: PodInfo[]
  /** workloadId → имя свежайшего пода: PodSelector считается в ядре, UI только рисует. */
  freshest: Record<string, string>
  fetchedAt: number
  cluster: string
}

export type PodsResult = ({ ok: true } & PodsView) | KubeFail

export type KubeSessionResult = { ok: true; session: SessionInfo; meta: KubeSessionMeta } | KubeFail

export type KubeExecResult =
  | { ok: true; stdout: string; stderr: string; code: number | null; ms: number }
  | (KubeFail & {
      /** Команда упёрлась в интерактивный MFA — повторить в PTY (kube.execPty). */
      needsPty?: boolean
    })

export interface KubeEvents extends Record<string, unknown> {
  state: { view: KubeStateView }
  /** Появилась/исчезла kube-привязка сессии (null — сессия ушла из реестра). */
  session: { sessionId: string; meta: KubeSessionMeta | null }
}

/** Что KubeService нужно от AuthService (структурная зависимость, не импорт класса). */
interface AuthPort {
  getCached(): TshStatus | null
  refreshStatus(): Promise<TshStatus | null>
}

const EXEC_TIMEOUT_MS = 60_000
/**
 * Сколько живёт список подов: на населённом namespace `get pods` стоит секунды и
 * мегабайты, так что таблица, быстрые действия и трей делят один ответ. Важное
 * устаревание (под уехал) ловится не таймером, а сбросом кэша по смерти сессии.
 */
const PODS_TTL_MS = 15_000
/** Хвост имени пода для заголовка таба: `api @ xpgt9`. */
const shortPod = (name: string): string => name.slice(name.lastIndexOf('-') + 1)

/**
 * Kubernetes-раздел модуля teleport (M2, FR-K1…K7): прозрачный `kube login` при
 * несовпадении кластера, список подов с группировкой по workload'ам, bash/логи
 * (PTY-сессии) и one-shot команды. Владеет выбранным окружением — единая точка
 * правды для окна и трея.
 */
export class KubeService {
  readonly events = new Emitter<KubeEvents>()
  private env: EnvId = 'dev'
  private switching = false
  /** kube login сериализован: параллельные действия не дерутся за kubeconfig. */
  private loginChain: Promise<unknown> = Promise.resolve()
  private metas = new Map<string, KubeSessionMeta>()
  private podsCache = new Map<EnvId, PodsView>()
  /** Идущий запрос на окружение: параллельные вызовы делят один `get pods`. */
  private podsInflight = new Map<EnvId, Promise<PodsResult>>()

  constructor(
    private readonly cfg: () => KubeConfig,
    private readonly tsh: TshClient,
    private readonly sessions: SessionManager,
    private readonly pipelineFactory: PipelineFactory,
    private readonly auth: AuthPort,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock
  ) {
    this.sessions.events.on('removed', ({ id }) => {
      if (this.metas.delete(id)) this.events.emit('session', { sessionId: id, meta: null })
    })
    // Сигнал «список протух»: kube-сессия умерла — под мог уехать в rollout,
    // и «переподключиться к свежему» обязан выбирать по живому списку.
    this.sessions.events.on('state', ({ info }) => {
      const meta = this.metas.get(info.id)
      if (meta && (info.state === 'exited' || info.state === 'failed')) {
        this.podsCache.delete(meta.env)
      }
    })
  }

  state(): KubeStateView {
    const c = this.cfg()
    return {
      env: this.env,
      namespace: c.namespace,
      cluster: c.clusters[this.env],
      currentCluster: this.auth.getCached()?.kubeCluster ?? null,
      switching: this.switching,
      workloads: c.workloads.map((w) => ({ id: w.id, title: w.title }))
    }
  }

  sessionMetas(): KubeSessionMeta[] {
    return [...this.metas.values()]
  }

  setEnv(env: EnvId): KubeStateView {
    this.env = env
    this.emitState()
    return this.state()
  }

  /**
   * Привести активный kube-контекст к окружению (FR-K1). Уже совпадает —
   * ничего не делаем: `kube login` не бесплатный (сеть + перезапись kubeconfig).
   */
  async ensureCluster(env: EnvId): Promise<{ ok: true; cluster: string } | KubeFail> {
    const c = this.cfg()
    const target = c.clusters[env]
    // Единственные ворота в tsh для всех kube-действий: без настроенного kube
    // незачем звать tsh и получать в баннер «kube-cluster name is required».
    const missing =
      c.namespace.trim() === '' ? 'kube.namespace'
      : target.trim() === '' ? `kube.clusters.${env}`
      : null
    if (missing) return { ok: false, error: `Kubernetes не настроен: в конфиге пуст ${missing}.` }
    if ((await this.currentCluster()) === target) return { ok: true, cluster: target }
    // очередь: два действия подряд не должны логиниться в кластер одновременно
    const run = this.loginChain.then(() => this.kubeLogin(target))
    this.loginChain = run.catch(() => undefined)
    return run
  }

  /**
   * Активный kube-контекст. Пустой кэш статуса — не «контекста нет»: на холодном
   * старте действие может обогнать первый `tsh status`, и без ожидания мы бы
   * логинились в кластер, который и так активен (поймано на живом прогоне).
   */
  private async currentCluster(): Promise<string | null> {
    const cached = this.auth.getCached()
    if (cached) return cached.kubeCluster
    return (await this.auth.refreshStatus())?.kubeCluster ?? null
  }

  private async kubeLogin(target: string): Promise<{ ok: true; cluster: string } | KubeFail> {
    if ((await this.currentCluster()) === target) return { ok: true, cluster: target }
    this.switching = true
    this.emitState()
    try {
      const res = await this.tsh.kubeLogin(target)
      if (res.code !== 0) {
        const err = (res.stderr || res.stdout).trim() || `tsh kube login ${target}: не удалось`
        this.logger.warn(`kube login ${target}: exit ${String(res.code)}`, err)
        return this.fail(err)
      }
      this.logger.info(`kube-контекст переключён на ${target}`)
      await this.auth.refreshStatus()
      return { ok: true, cluster: target }
    } finally {
      this.switching = false
      this.emitState()
    }
  }

  /**
   * Список подов namespace (FR-K2) с проставленным workloadId. Отдаёт кэш моложе
   * `PODS_TTL_MS`; `force` — кнопка «Обновить» (к идущему запросу всё равно
   * подключается: он свежее любого кэша).
   */
  async listPods(env: EnvId = this.env, opts: { force?: boolean } = {}): Promise<PodsResult> {
    const cached = this.podsCache.get(env)
    if (!opts.force && cached && this.clock.now() - cached.fetchedAt < PODS_TTL_MS) {
      return { ok: true, ...cached }
    }
    const inflight = this.podsInflight.get(env)
    if (inflight) return inflight
    const run = this.fetchPods(env).finally(() => this.podsInflight.delete(env))
    this.podsInflight.set(env, run)
    return run
  }

  private async fetchPods(env: EnvId): Promise<PodsResult> {
    const ensured = await this.ensureCluster(env)
    if (!ensured.ok) return ensured
    const c = this.cfg()
    const res = await this.tsh.getPodsRaw(c.namespace)
    if (res.code !== 0) {
      return this.fail((res.stderr || res.stdout).trim() || 'kubectl get pods: ненулевой exit')
    }
    const pods = parsePods(res.stdout, c.workloads)
    if (!pods) return this.fail('Не разобрал вывод kubectl get pods -o json')
    const freshest: Record<string, string> = {}
    for (const w of c.workloads) {
      const pod = selectFreshest(pods, w.id)
      if (pod) freshest[w.id] = pod.name
    }
    const view: PodsView = { pods, freshest, fetchedAt: this.clock.now(), cluster: ensured.cluster }
    this.podsCache.set(env, view)
    return { ok: true, ...view }
  }

  /** Bash в контейнер (FR-K4, US-04): под — указанный или свежайший. */
  async bash(req: { env: EnvId; workloadId: string | null; pod?: string }): Promise<KubeSessionResult> {
    const resolved = await this.resolveTarget(req)
    if (!resolved.ok) return resolved
    const { target, workload } = resolved
    const title = `bash: ${workload?.title ?? target.pod} @ ${shortPod(target.pod)} (${req.env})`
    return this.startSession(this.tsh.kubeBashCommand(target, title), 'bash', req, target)
  }

  /** Логи контейнера (FR-K6): PTY-сессия, пауза/поиск — на стороне UI. */
  async logs(req: {
    env: EnvId
    workloadId: string | null
    pod?: string
    tail?: number
    follow?: boolean
  }): Promise<KubeSessionResult> {
    const resolved = await this.resolveTarget(req)
    if (!resolved.ok) return resolved
    const { target, workload } = resolved
    const follow = req.follow ?? true
    const tail = req.tail ?? this.cfg().logsTail
    const title = `логи: ${workload?.title ?? target.pod} @ ${shortPod(target.pod)} (${req.env})`
    const cmd = this.tsh.kubeLogsCommand(target, { tail, follow }, title)
    return this.startSession(cmd, 'logs', req, target)
  }

  /** One-shot команда в контейнере (FR-K5): вывод — панелью, без PTY. */
  async exec(req: {
    env: EnvId
    workloadId: string | null
    pod?: string
    command: string
  }): Promise<KubeExecResult> {
    const resolved = await this.resolveTarget(req)
    if (!resolved.ok) return resolved
    const startedAt = this.clock.now()
    const res = await this.tsh.kubeExecOnce(resolved.target, req.command, EXEC_TIMEOUT_MS)
    const ms = this.clock.now() - startedAt
    if (res.code === null) {
      const err = res.stderr.trim() || `Команда не отработала за ${EXEC_TIMEOUT_MS / 1000} с`
      return { ...this.fail(err), needsPty: isMfaError(res.stderr) }
    }
    if (res.code !== 0 && isMfaError(res.stderr)) {
      // per-session MFA: exec-канал не переживёт интерактивный промпт (docs/04 §3.3)
      return { ...this.fail(res.stderr.trim()), needsPty: true }
    }
    // ненулевой exit самой команды — валидный результат; ANSI режем: панель
    // вывода не терминал, раскраска ушла бы мусором вроде `[31m` (docs/02 §7)
    return { ok: true, stdout: stripAnsi(res.stdout), stderr: stripAnsi(res.stderr), code: res.code, ms }
  }

  /** Та же one-shot команда, но видимым PTY-табом — фолбэк для MFA. */
  async execPty(req: {
    env: EnvId
    workloadId: string | null
    pod?: string
    command: string
  }): Promise<KubeSessionResult> {
    const resolved = await this.resolveTarget(req)
    if (!resolved.ok) return resolved
    const { target, workload } = resolved
    const title = `cmd: ${workload?.title ?? target.pod} @ ${shortPod(target.pod)} (${req.env})`
    const cmd = this.tsh.kubeExecPtyCommand(target, req.command, title)
    return this.startSession(cmd, 'exec', req, target)
  }

  private startSession(
    cmd: { title: string; cmd: string; args: string[]; sanitizeTerminalReports: boolean },
    kind: KubeSessionMeta['kind'],
    req: { env: EnvId; workloadId: string | null },
    target: KubeTarget
  ): KubeSessionResult {
    const info = this.sessions.start(cmd, this.pipelineFactory)
    const meta: KubeSessionMeta = {
      sessionId: info.id,
      kind,
      env: req.env,
      workloadId: req.workloadId,
      pod: target.pod,
      container: target.container
    }
    this.metas.set(info.id, meta)
    this.events.emit('session', { sessionId: info.id, meta })
    return { ok: true, session: info, meta }
  }

  /**
   * Под + контейнер для действия: явно выбранный под либо свежайший под
   * workload'а (docs/04 §3.3). Список нужен всегда — по нему же подбирается
   * контейнер из реального spec (containerAutoDiscover); обычно это кэш.
   */
  private async resolveTarget(req: {
    env: EnvId
    workloadId: string | null
    pod?: string
  }): Promise<{ ok: true; target: KubeTarget; workload: KubeWorkload | null } | KubeFail> {
    const c = this.cfg()
    const workload = req.workloadId
      ? (c.workloads.find((w) => w.id === req.workloadId) ?? null)
      : null
    if (req.workloadId && !workload) return this.fail(`Workload «${req.workloadId}» не найден в конфиге`)

    const list = await this.listPods(req.env)
    if (!list.ok) return list

    let pod: PodInfo | null
    if (req.pod) {
      pod = list.pods.find((p) => p.name === req.pod) ?? null
      if (!pod) return this.fail(`Под ${req.pod} не найден — список устарел, обнови`)
    } else if (workload) {
      pod = selectFreshest(list.pods, workload.id)
      if (!pod) return this.fail(`Нет готового Running-пода для «${workload.title}»`)
    } else {
      return this.fail('Не указан ни под, ни workload')
    }

    const container = workload ? resolveContainer(pod, workload) : defaultContainer(pod)
    return { ok: true, target: { namespace: c.namespace, pod: pod.name, container }, workload }
  }

  /** tsh красит stderr — в UI это ушло бы как `[31mERROR: [0m…` (поймано вживую). */
  private fail(raw: string): KubeFail {
    const error = stripAnsi(raw).trim()
    const needsLogin = isAuthError(error)
    // серт мог протухнуть только что: обновляем статус, чтобы поднялся баннер
    if (needsLogin) void this.auth.refreshStatus()
    return { ok: false, error, needsLogin }
  }

  private emitState(): void {
    this.events.emit('state', { view: this.state() })
  }
}
