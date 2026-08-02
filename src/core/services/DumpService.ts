import type { ProxyView } from '../domain/proxy'
import type { SessionInfo } from '../domain/session'
import { expandTemplate, tunnelBlocker } from '../domain/sql'
import type { DbProxyPreset, DumpPreset } from '../modules/teleport/types'
import type { Clock } from '../ports/Clock'
import { systemClock } from '../ports/Clock'
import type { FileStat } from '../ports/FileStat'
import type { Logger } from '../ports/Logger'
import { Emitter } from '../util/Emitter'
import type { SessionManager } from './SessionManager'

/** Задача дампа для UI и уведомлений (FR-Q5). */
export interface DumpTaskView {
  /** Сессия дампа: её же таб показывает вывод команды. */
  sessionId: string
  dumpId: string
  title: string
  presetId: string
  /** Подпись базы (dbName пресета). */
  label: string
  file: string
  /** Размер файла на диске — прогресс: у pg_dump другого индикатора нет. */
  bytes: number
  startedAt: number
  state: 'running' | 'done' | 'failed'
  /** Длительность после завершения. */
  ms: number | null
  error: string | null
}

export interface DumpEvents extends Record<string, unknown> {
  progress: { task: DumpTaskView }
  /** Задача дошла до конца — повод для системного уведомления (docs/02 §7). */
  finished: { task: DumpTaskView }
}

export type DumpStartResult =
  | { ok: true; session: SessionInfo; task: DumpTaskView }
  | { ok: false; reason: 'unknown-preset' | 'no-tunnel'; error: string }

/** Как часто перечитываем размер файла: дамп идёт минутами, чаще незачем. */
const PROGRESS_MS = 1000

/**
 * Пресеты `pg_dump` (FR-Q5, docs/04 §3.4): команда из конфига разворачивается
 * подстановками выбранного туннеля и уходит PTY-сессией через `sh -lc` — так в
 * шаблоне работают редирект и пайпы, а вывод и код возврата видны обычным табом
 * ([ADR-0007](../../../docs/adr/ADR-0007-kube-streams-via-pty.md) — тот же приём,
 * что у логов). Прогресс — рост файла на диске.
 */
export class DumpService {
  readonly events = new Emitter<DumpEvents>()
  private tasks = new Map<string, DumpTaskView>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly presets: DbProxyPreset[],
    private readonly dumps: DumpPreset[],
    private readonly proxies: () => ProxyView[],
    private readonly sessions: SessionManager,
    private readonly files: FileStat,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock
  ) {
    this.sessions.events.on('state', ({ info }) => {
      if (info.state === 'exited' || info.state === 'failed') this.finish(info)
    })
    // таб закрыли — задача уходит вместе с ним (в UI её показывает та же сессия)
    this.sessions.events.on('removed', ({ id }) => this.tasks.delete(id))
  }

  list(): DumpTaskView[] {
    return [...this.tasks.values()]
  }

  /** Имя файла, предложенное в диалоге сохранения (шаблон из пресета). */
  defaultFile(dumpId: string, presetId: string): string | null {
    const dump = this.dumps.find((d) => d.id === dumpId)
    const preset = this.presets.find((p) => p.id === presetId)
    if (!dump || !preset) return null
    return expandTemplate(dump.defaultFile, this.vars(preset, ''))
  }

  start(req: { dumpId: string; presetId: string; file: string }): DumpStartResult {
    const dump = this.dumps.find((d) => d.id === req.dumpId)
    const preset = this.presets.find((p) => p.id === req.presetId)
    if (!dump || !preset) {
      return { ok: false, reason: 'unknown-preset', error: 'Пресет дампа или базы не найден' }
    }
    const blocked = tunnelBlocker(
      this.proxies().find((p) => p.presetId === preset.id),
      preset.dbName
    )
    if (blocked) return { ok: false, reason: 'no-tunnel', error: blocked }

    const command = expandTemplate(dump.command, this.vars(preset, req.file))
    const session = this.sessions.start({
      title: `${dump.title}: ${preset.dbName}`,
      cmd: 'sh',
      args: ['-lc', command],
      // вывод pg_dump читает человек в табе; фильтр ввода тут ни при чём
      sanitizeTerminalReports: false
    })
    const task: DumpTaskView = {
      sessionId: session.id,
      dumpId: dump.id,
      title: dump.title,
      presetId: preset.id,
      label: preset.dbName,
      file: req.file,
      bytes: 0,
      startedAt: this.clock.now(),
      state: session.state === 'failed' ? 'failed' : 'running',
      ms: null,
      error: session.state === 'failed' ? 'Не удалось запустить команду дампа' : null
    }
    this.tasks.set(session.id, task)
    this.logger.info(`Дамп «${dump.title}» → ${req.file}`, { command })
    this.events.emit('progress', { task: { ...task } })
    if (task.state === 'running') this.ensureTimer()
    return { ok: true, session, task: { ...task } }
  }

  /** Выход приложения: таймер прочь (сессии гасит SessionManager). */
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private vars(preset: DbProxyPreset, file: string): Record<string, string> {
    const d = new Date(this.clock.now())
    const pad = (n: number): string => String(n).padStart(2, '0')
    return {
      port: String(preset.port),
      dbName: preset.dbName,
      dbUser: preset.dbUser,
      env: preset.env,
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      file
    }
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), PROGRESS_MS)
  }

  private async tick(): Promise<void> {
    const running = [...this.tasks.values()].filter((t) => t.state === 'running')
    if (running.length === 0) {
      this.dispose()
      return
    }
    for (const task of running) {
      const bytes = await this.files.size(task.file)
      if (bytes === null || bytes === task.bytes) continue
      task.bytes = bytes
      this.events.emit('progress', { task: { ...task } })
    }
  }

  private finish(info: SessionInfo): void {
    const task = this.tasks.get(info.id)
    if (!task || task.state !== 'running') return
    void this.files.size(task.file).then((bytes) => {
      task.bytes = bytes ?? task.bytes
      task.ms = this.clock.now() - task.startedAt
      task.state = info.exitCode === 0 ? 'done' : 'failed'
      task.error =
        info.exitCode === 0 ? null : (
          `Команда дампа завершилась с кодом ${info.exitCode ?? '—'} — вывод в табе «${task.title}».`
        )
      this.events.emit('progress', { task: { ...task } })
      this.events.emit('finished', { task: { ...task } })
    })
  }
}
