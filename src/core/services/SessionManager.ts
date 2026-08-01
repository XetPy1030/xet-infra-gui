import { randomUUID } from 'node:crypto'
import type { SessionInfo, SessionSpec } from '../domain/session'
import { isAliveState } from '../domain/session'
import type { Logger } from '../ports/Logger'
import type { PtyFactory, PtyHandle } from '../ports/PtyFactory'
import { Emitter } from '../util/Emitter'
import { RingBuffer } from '../util/RingBuffer'
import { stripTerminalReports } from '../util/terminalInput'
import type { PipelineIO, PromptEvent, PromptKind, PromptPhase } from './PromptPipeline'

export interface SessionEvents extends Record<string, unknown> {
  /** end — абсолютный offset конца чанка в потоке (для дедупа replay, см. shared/stream). */
  data: { id: string; data: string; end: number }
  state: { info: SessionInfo }
  prompt: { id: string; kind: PromptKind; phase: PromptPhase }
  /** Сессия удалена из реестра (dispose завершённой) — UI закрывает таб. */
  removed: { id: string }
}

export interface SessionSnapshot {
  info: SessionInfo
  buffer: string
  /** Сколько всего символов произведено сессией — watermark для дедупа живых чанков. */
  cursor: number
}

/** Пайплайн создаётся на сессию: фабрика получает IO и возвращает feed-объект. */
export type PipelineFactory = (io: PipelineIO) => { feed(chunk: string): void }

interface Runtime {
  info: SessionInfo
  spec: SessionSpec
  pty: PtyHandle | null
  buffer: RingBuffer
  batch: string[]
  /** Монотонный счётчик произведённых символов (offset конца потока). */
  produced: number
  /** Offset конца последнего отправленного renderer'у батча. */
  flushedEnd: number
  /** Абсолютный watermark подтверждённого renderer'ом (session.ack, идемпотентен). */
  acked: number
  /** Пауза от backpressure (renderer не поспевает). */
  paused: boolean
  /** Пауза по кнопке пользователя — сильнее backpressure, снимается только вручную. */
  manualPaused: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  pipeline: { feed(chunk: string): void } | null
}

/** Окно батчинга PTY→UI (docs/03 §6). */
const BATCH_MS = 12
const KILL_GRACE_MS = 3000
/**
 * Backpressure (docs/03 §6): pause при неподтверждённом хвосте > HIGH,
 * resume при < LOW. Ack — абсолютный offset → двойные/пропущенные ack безвредны.
 */
const FLOW_HIGH_WATER = 512 * 1024
const FLOW_LOW_WATER = 128 * 1024

/**
 * Реестр сессий: spawn/write/resize/exit, FSM-состояния, батчинг вывода,
 * ring buffer для восстановления окна. Живёт в main; renderer видит только события.
 */
export class SessionManager {
  readonly events = new Emitter<SessionEvents>()
  private sessions = new Map<string, Runtime>()
  /** Flow control активен только пока есть кому подтверждать (окно открыто). */
  private flowEnabled = false

  constructor(
    private readonly ptyFactory: PtyFactory,
    private readonly logger: Logger
  ) {}

  start(spec: SessionSpec, pipelineFactory?: PipelineFactory): SessionInfo {
    const id = randomUUID()
    const rt: Runtime = {
      info: {
        id,
        title: spec.title,
        state: 'spawning',
        exitCode: null,
        startedAt: Date.now(),
        paused: false
      },
      spec,
      pty: null,
      buffer: new RingBuffer(),
      batch: [],
      produced: 0,
      flushedEnd: 0,
      acked: 0,
      paused: false,
      manualPaused: false,
      flushTimer: null,
      killTimer: null,
      pipeline: null
    }
    this.sessions.set(id, rt)

    if (pipelineFactory) {
      rt.pipeline = pipelineFactory({
        write: (data) => rt.pty?.write(data),
        onEvent: (e) => this.onPrompt(rt, e)
      })
    }

    try {
      rt.pty = this.ptyFactory.spawn(spec)
    } catch (e) {
      this.logger.error(`Сессия «${spec.title}»: spawn не удался`, e)
      rt.buffer.push(`[xet] Не удалось запустить: ${spec.cmd} — ${String(e)}\r\n`)
      this.setState(rt, 'failed')
      return { ...rt.info }
    }

    rt.pty.onData((data) => this.onData(rt, data))
    rt.pty.onExit(({ exitCode }) => this.onExit(rt, exitCode))
    this.logger.info(`Сессия «${spec.title}» запущена`, { id, cmd: spec.cmd, args: spec.args })
    this.emitState(rt)
    return { ...rt.info }
  }

  write(id: string, data: string): void {
    const rt = this.sessions.get(id)
    if (!rt?.pty) return
    // Отсекаем авто-ответы xterm на запросы tsh (портят чтение пароля при логине).
    // Ответы пайплайна (пароль/OTP) идут мимо этого метода — они не фильтруются.
    const clean = rt.spec.sanitizeTerminalReports ? stripTerminalReports(data) : data
    if (clean.length === 0) return
    rt.pty.write(clean)
    // ручной ввод ответа на промпт: Enter → считаем, что ждать нечего
    if (rt.info.state.startsWith('awaiting') && clean.includes('\r')) {
      this.setState(rt, 'running')
    }
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2 || cols > 1000 || rows > 1000) return
    this.sessions.get(id)?.pty?.resize(cols, rows)
  }

  stop(id: string): void {
    const rt = this.sessions.get(id)
    if (!rt?.pty) return
    rt.pty.kill('SIGTERM')
    rt.killTimer = setTimeout(() => rt.pty?.kill('SIGKILL'), KILL_GRACE_MS)
  }

  /** Полный выход из приложения: никого не оставляем сиротой (NFR-2). */
  disposeAll(): void {
    for (const rt of this.sessions.values()) {
      if (rt.killTimer) clearTimeout(rt.killTimer)
      if (rt.flushTimer) clearTimeout(rt.flushTimer)
      rt.pty?.kill('SIGKILL')
      rt.pty = null
    }
  }

  /**
   * Убрать завершённую сессию из реестра (чистка Map — иначе растёт на каждый
   * логин/рестарт прокси). Живые не трогаем: сначала stop.
   */
  remove(id: string): boolean {
    const rt = this.sessions.get(id)
    if (!rt || isAliveState(rt.info.state)) return false
    if (rt.flushTimer) clearTimeout(rt.flushTimer)
    if (rt.killTimer) clearTimeout(rt.killTimer)
    this.sessions.delete(id)
    this.events.emit('removed', { id })
    return true
  }

  /**
   * Health-переход supervised-сессии (ProxySupervisor/HealthMonitor):
   * допустим только поверх running/healthy/degraded — не сбивает FSM auth-фазы.
   */
  markHealth(id: string, state: 'healthy' | 'degraded'): void {
    const rt = this.sessions.get(id)
    if (!rt) return
    if (rt.info.state !== 'running' && rt.info.state !== 'healthy' && rt.info.state !== 'degraded')
      return
    this.setState(rt, state)
  }

  /** Подтверждение renderer'ом переваренного вывода — абсолютный offset потока. */
  ack(id: string, upTo: number): void {
    const rt = this.sessions.get(id)
    if (!rt) return
    rt.acked = Math.max(rt.acked, Math.min(upTo, rt.flushedEnd))
    if (rt.paused && rt.flushedEnd - rt.acked < FLOW_LOW_WATER) {
      rt.paused = false
      if (!rt.manualPaused) rt.pty?.resume()
    }
  }

  /**
   * Пауза по кнопке (логи `--follow`, FR-K6): держим PTY остановленным, пока
   * пользователь не отпустит. Сильнее backpressure — снятие flow-паузы её не трогает.
   * Вывод не теряется: он копится в трубе процесса, после resume дойдёт весь.
   */
  setPaused(id: string, paused: boolean): void {
    const rt = this.sessions.get(id)
    if (!rt || rt.manualPaused === paused) return
    rt.manualPaused = paused
    if (paused) rt.pty?.pause()
    else if (!rt.paused) rt.pty?.resume()
    rt.info.paused = paused
    this.emitState(rt)
  }

  /**
   * Окно закрылось → ack'ов не будет: выключаем flow control и будим всех.
   * Окно открылось → начинаем с чистого листа (acked = flushedEnd), иначе
   * накопленный без окна хвост мгновенно уронил бы сессии в pause.
   */
  setFlowEnabled(enabled: boolean): void {
    this.flowEnabled = enabled
    for (const rt of this.sessions.values()) {
      if (enabled) {
        rt.acked = rt.flushedEnd
      } else if (rt.paused) {
        rt.paused = false
        if (!rt.manualPaused) rt.pty?.resume()
      }
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((rt) => ({ ...rt.info }))
  }

  snapshot(id: string): SessionSnapshot | null {
    const rt = this.sessions.get(id)
    if (!rt) return null
    return { info: { ...rt.info }, buffer: rt.buffer.toString(), cursor: rt.produced }
  }

  isAlive(id: string): boolean {
    const rt = this.sessions.get(id)
    return !!rt && isAliveState(rt.info.state)
  }

  private onData(rt: Runtime, data: string): void {
    rt.buffer.push(data)
    rt.batch.push(data)
    rt.produced += data.length
    if (!rt.flushTimer) {
      rt.flushTimer = setTimeout(() => this.flush(rt), BATCH_MS)
    }
    // Пайплайн — раньше перехода: если в чанке промпт, состояние станет
    // awaiting_*, и «running» его не перебьёт (FSM docs/03 §4.2:
    // spawning → awaiting_* при промпте, spawning → running, если промптов нет).
    rt.pipeline?.feed(data)
    if (rt.info.state === 'spawning') this.setState(rt, 'running')
  }

  private flush(rt: Runtime): void {
    rt.flushTimer = null
    if (rt.batch.length === 0) return
    const data = rt.batch.join('')
    rt.batch = []
    // produced уже учитывает весь батч → это offset конца data в потоке
    rt.flushedEnd = rt.produced
    this.events.emit('data', { id: rt.info.id, data, end: rt.produced })
    if (
      this.flowEnabled &&
      !rt.paused &&
      rt.pty &&
      rt.flushedEnd - rt.acked > FLOW_HIGH_WATER
    ) {
      rt.paused = true
      rt.pty.pause()
    }
  }

  private onExit(rt: Runtime, exitCode: number | null): void {
    if (rt.killTimer) {
      clearTimeout(rt.killTimer)
      rt.killTimer = null
    }
    if (rt.flushTimer) clearTimeout(rt.flushTimer)
    this.flush(rt)
    rt.pty = null
    rt.info.exitCode = exitCode
    this.logger.info(`Сессия «${rt.info.title}» завершилась`, { id: rt.info.id, exitCode })
    this.setState(rt, exitCode === 0 ? 'exited' : 'failed')
  }

  private onPrompt(rt: Runtime, e: PromptEvent): void {
    switch (e.phase) {
      case 'detected':
        this.setState(rt, e.kind === 'password' ? 'awaiting_password' : 'awaiting_otp')
        break
      case 'answered':
        this.setState(rt, 'running')
        break
      case 'manual':
        // остаёмся в awaiting_*: UI подскажет ввести вручную в терминале
        break
    }
    this.events.emit('prompt', { id: rt.info.id, kind: e.kind, phase: e.phase })
  }

  private setState(rt: Runtime, state: SessionInfo['state']): void {
    if (rt.info.state === state) return
    rt.info.state = state
    this.emitState(rt)
  }

  private emitState(rt: Runtime): void {
    this.events.emit('state', { info: { ...rt.info } })
  }
}
