import type { ProxyRunState, ProxyView } from '../domain/proxy'
import type { SessionInfo } from '../domain/session'
import { isAliveState } from '../domain/session'
import type { TshClient } from '../modules/teleport/TshClient'
import type { DbProxyPreset } from '../modules/teleport/types'
import type { Clock } from '../ports/Clock'
import { systemClock } from '../ports/Clock'
import type { Logger } from '../ports/Logger'
import type { ProcessRunner } from '../ports/ProcessRunner'
import type { TcpProbe } from '../ports/TcpProbe'
import { Emitter } from '../util/Emitter'
import type { PipelineFactory, SessionManager } from './SessionManager'

export interface ProxyEvents extends Record<string, unknown> {
  state: { view: ProxyView }
}

export type ProxyStartResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-preset' }
  /** Порт занят другим НАШИМ пресетом (стратегия shared): UI предлагает переключение. */
  | { ok: false; reason: 'conflict'; conflictPresetId: string; conflictLabel: string }
  /** Порт занят посторонним процессом: hint — вывод lsof (docs/04 §7). */
  | { ok: false; reason: 'busy-port'; hint: string }

interface ProxyRuntime {
  preset: DbProxyPreset
  /** Тумблер в положении «вкл» (намерение пользователя). */
  desired: boolean
  state: ProxyRunState
  sessionId: string | null
  attempts: number
  error: string | null
  everHealthy: boolean
  probeStartedAt: number
  /** Управляемый останов (stop/restart): onSessionDown не вмешивается. */
  stopping: boolean
  probing: boolean
  probeTimer: ReturnType<typeof setTimeout> | null
  restartTimer: ReturnType<typeof setTimeout> | null
  stableTimer: ReturnType<typeof setTimeout> | null
}

/** Политика рестартов (docs/03 §4 Supervisor): backoff + лимит попыток. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
const MAX_ATTEMPTS = 5
/** Живёт стабильно дольше этого — счётчик попыток обнуляется. */
const STABLE_RESET_MS = 30_000
/** Probe: часто до первой готовности, редко после (докидывает HealthMonitor-ритм). */
const PROBE_FAST_MS = 500
const PROBE_SLOW_MS = 10_000
const PROBE_TIMEOUT_MS = 1500
/** Порт так и не открылся при живом процессе → degraded (но продолжаем ждать). */
const READY_TIMEOUT_MS = 30_000
const STOP_WAIT_MS = 6000

/**
 * Supervisor DB-прокси (docs/03 §4, docs/04 §3.2): прокси — это пресет с
 * жизненным циклом поверх PTY-сессий (рестарт = новая сессия). Владеет и
 * readiness-, и health-probe'ами своих туннелей — единственный источник
 * правды о состоянии прокси; HealthMonitor занимается только сертификатом.
 */
export class ProxySupervisor {
  readonly events = new Emitter<ProxyEvents>()
  private proxies = new Map<string, ProxyRuntime>()

  constructor(
    presets: DbProxyPreset[],
    private readonly sessions: SessionManager,
    private readonly tsh: Pick<TshClient, 'proxyDbCommand'>,
    private readonly probe: TcpProbe,
    private readonly pipelineFactory: PipelineFactory,
    private readonly runner: ProcessRunner | null,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock
  ) {
    for (const preset of presets) {
      this.proxies.set(preset.id, {
        preset,
        desired: false,
        state: 'off',
        sessionId: null,
        attempts: 0,
        error: null,
        everHealthy: false,
        probeStartedAt: 0,
        stopping: false,
        probing: false,
        probeTimer: null,
        restartTimer: null,
        stableTimer: null
      })
    }
    this.sessions.events.on('state', ({ info }) => this.onSessionState(info))
  }

  list(): ProxyView[] {
    return [...this.proxies.values()].map((rt) => this.view(rt))
  }

  /**
   * Включить пресет. Конфликт shared-порта с другим НАШИМ пресетом без force —
   * возвращаем conflict (UI подтверждает переключение и повторяет с force).
   */
  async start(presetId: string, opts: { force?: boolean } = {}): Promise<ProxyStartResult> {
    const rt = this.proxies.get(presetId)
    if (!rt) return { ok: false, reason: 'unknown-preset' }
    if (rt.desired && rt.sessionId && this.sessions.isAlive(rt.sessionId)) return { ok: true }

    const rival = [...this.proxies.values()].find(
      (o) => o !== rt && o.preset.port === rt.preset.port && o.desired
    )
    if (rival) {
      if (!opts.force) {
        return {
          ok: false,
          reason: 'conflict',
          conflictPresetId: rival.preset.id,
          conflictLabel: rival.preset.dbName
        }
      }
      await this.stop(rival.preset.id)
    }

    // Порт слушает кто-то посторонний → заведомый EADDRINUSE, не спавним (docs/04 §7)
    if (await this.probe.check('127.0.0.1', rt.preset.port, PROBE_TIMEOUT_MS)) {
      const hint = await this.lsofHint(rt.preset.port)
      rt.error = `Порт ${rt.preset.port} занят посторонним процессом.${hint ? `\n${hint}` : ''}`
      this.setState(rt, 'error')
      return { ok: false, reason: 'busy-port', hint: rt.error }
    }

    rt.desired = true
    rt.attempts = 0
    rt.error = null
    rt.everHealthy = false
    this.spawnAttempt(rt)
    return { ok: true }
  }

  /** Выключить пресет: SIGTERM сессии, дождаться выхода, убрать её из реестра. */
  async stop(presetId: string): Promise<void> {
    const rt = this.proxies.get(presetId)
    if (!rt) return
    rt.desired = false
    rt.error = null
    this.clearTimers(rt)
    const id = rt.sessionId
    if (id && this.sessions.isAlive(id)) {
      rt.stopping = true
      const exited = this.waitForExit(id)
      this.sessions.stop(id)
      await exited
      rt.stopping = false
    }
    if (rt.sessionId) {
      this.sessions.remove(rt.sessionId)
      rt.sessionId = null
    }
    this.setState(rt, 'off')
  }

  /**
   * Каскад после перелогина (docs/04 §6): все db-прокси имеют restartOnRelogin —
   * рестартуем включённые, чтобы туннели пересоздались на свежем сертификате.
   */
  async restartMarked(): Promise<void> {
    for (const rt of this.proxies.values()) {
      if (!rt.desired) continue
      this.logger.info(`Прокси ${rt.preset.id}: рестарт после перелогина`)
      this.clearTimers(rt)
      const id = rt.sessionId
      if (id && this.sessions.isAlive(id)) {
        rt.stopping = true
        this.setState(rt, 'restarting')
        const exited = this.waitForExit(id)
        this.sessions.stop(id)
        await exited
        rt.stopping = false
      }
      rt.attempts = 0
      rt.everHealthy = false
      this.spawnAttempt(rt)
    }
  }

  /** Внеочередная проверка всех активных туннелей (powerMonitor.resume). */
  probeNow(): void {
    for (const rt of this.proxies.values()) {
      if (rt.desired && rt.sessionId && this.sessions.isAlive(rt.sessionId)) {
        void this.probeOnce(rt)
      }
    }
  }

  /** Выход приложения: таймеры прочь (сессии гасит SessionManager.disposeAll). */
  dispose(): void {
    for (const rt of this.proxies.values()) this.clearTimers(rt)
  }

  private onSessionState(info: SessionInfo): void {
    const rt = this.bySession(info.id)
    if (!rt) return
    switch (info.state) {
      case 'awaiting_password':
      case 'awaiting_otp':
        // с точки зрения тумблера — «ждёт код» (пароль спросит только протухший серт)
        this.setState(rt, 'awaiting_otp')
        break
      case 'running':
        if (rt.state === 'awaiting_otp') this.setState(rt, 'probing')
        break
      case 'exited':
      case 'failed':
        this.onSessionDown(rt)
        break
      default:
        // spawning — переходное; healthy/degraded — наше же эхо через markHealth
        break
    }
  }

  private onSessionDown(rt: ProxyRuntime): void {
    this.clearTimers(rt)
    if (rt.stopping) return
    if (!rt.desired) {
      this.setState(rt, 'off')
      return
    }
    rt.attempts += 1
    if (rt.attempts > MAX_ATTEMPTS) {
      rt.desired = false
      rt.error = `Прокси падает подряд (${MAX_ATTEMPTS} попыток) — остановлен. Вывод — в табе сессии.`
      this.setState(rt, 'error')
      this.logger.error(`Прокси ${rt.preset.id}: исчерпан лимит рестартов`)
      return
    }
    const delay = BACKOFF_MS[Math.min(rt.attempts - 1, BACKOFF_MS.length - 1)]
    this.logger.warn(
      `Прокси ${rt.preset.id}: упал, рестарт через ${delay} мс (попытка ${rt.attempts}/${MAX_ATTEMPTS})`
    )
    this.setState(rt, 'restarting')
    rt.restartTimer = setTimeout(() => this.spawnAttempt(rt), delay)
  }

  private spawnAttempt(rt: ProxyRuntime): void {
    if (rt.restartTimer) {
      clearTimeout(rt.restartTimer)
      rt.restartTimer = null
    }
    if (!rt.desired) return
    if (rt.sessionId) {
      // прошлая (мёртвая) сессия рестартуемого прокси — из реестра, не копим табы
      this.sessions.remove(rt.sessionId)
      rt.sessionId = null
    }
    const spec = this.tsh.proxyDbCommand(rt.preset)
    const info = this.sessions.start(spec, this.pipelineFactory)
    rt.sessionId = info.id
    rt.probeStartedAt = this.clock.now()
    if (!isAliveState(info.state)) {
      // spawn упал синхронно (tsh не найден) — событие state нас не нашло по id
      this.onSessionDown(rt)
      return
    }
    this.setState(rt, 'probing')
    this.scheduleProbe(rt, PROBE_FAST_MS)
  }

  private scheduleProbe(rt: ProxyRuntime, ms: number): void {
    if (rt.probeTimer) clearTimeout(rt.probeTimer)
    rt.probeTimer = setTimeout(() => void this.probeOnce(rt), ms)
  }

  private async probeOnce(rt: ProxyRuntime): Promise<void> {
    if (rt.probeTimer) {
      clearTimeout(rt.probeTimer)
      rt.probeTimer = null
    }
    if (rt.probing) return // probe уже в полёте
    const sessionId = rt.sessionId
    if (!rt.desired || !sessionId || !this.sessions.isAlive(sessionId)) return
    rt.probing = true
    const ok = await this.probe.check('127.0.0.1', rt.preset.port, PROBE_TIMEOUT_MS)
    rt.probing = false
    // за время probe мир мог измениться (рестарт/стоп) — не трогаем чужую сессию
    if (!rt.desired || rt.sessionId !== sessionId || !this.sessions.isAlive(sessionId)) return

    if (ok) {
      rt.everHealthy = true
      if (rt.state !== 'healthy') {
        this.sessions.markHealth(sessionId, 'healthy')
        this.setState(rt, 'healthy')
        if (rt.stableTimer) clearTimeout(rt.stableTimer)
        rt.stableTimer = setTimeout(() => {
          rt.attempts = 0
        }, STABLE_RESET_MS)
      }
      this.scheduleProbe(rt, PROBE_SLOW_MS)
      return
    }

    if (rt.state === 'healthy') {
      this.sessions.markHealth(sessionId, 'degraded')
      this.setState(rt, 'degraded')
    } else if (rt.state === 'probing' && this.clock.now() - rt.probeStartedAt > READY_TIMEOUT_MS) {
      // процесс жив, но порт так и не открылся — честно показываем деградацию
      this.setState(rt, 'degraded')
    }
    this.scheduleProbe(rt, rt.state === 'probing' ? PROBE_FAST_MS : PROBE_SLOW_MS)
  }

  private waitForExit(id: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sessions.isAlive(id)) {
        resolve()
        return
      }
      let off: (() => void) | null = null
      const timer = setTimeout(() => done(), STOP_WAIT_MS)
      const done = (): void => {
        clearTimeout(timer)
        off?.()
        resolve()
      }
      off = this.sessions.events.on('state', ({ info }) => {
        if (info.id === id && !isAliveState(info.state)) done()
      })
    })
  }

  private async lsofHint(port: number): Promise<string | null> {
    if (!this.runner) return null
    const res = await this.runner.run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      timeoutMs: 3000
    })
    const out = res.stdout.trim()
    return out || null
  }

  private bySession(sessionId: string): ProxyRuntime | null {
    for (const rt of this.proxies.values()) if (rt.sessionId === sessionId) return rt
    return null
  }

  private clearTimers(rt: ProxyRuntime): void {
    if (rt.probeTimer) clearTimeout(rt.probeTimer)
    if (rt.restartTimer) clearTimeout(rt.restartTimer)
    if (rt.stableTimer) clearTimeout(rt.stableTimer)
    rt.probeTimer = rt.restartTimer = rt.stableTimer = null
  }

  private setState(rt: ProxyRuntime, state: ProxyRunState): void {
    if (rt.state === state) return
    rt.state = state
    this.events.emit('state', { view: this.view(rt) })
  }

  private view(rt: ProxyRuntime): ProxyView {
    return {
      presetId: rt.preset.id,
      label: rt.preset.dbName,
      env: rt.preset.env,
      port: rt.preset.port,
      dangerous: rt.preset.dangerous,
      state: rt.state,
      sessionId: rt.sessionId,
      attempts: rt.attempts,
      error: rt.error
    }
  }
}
