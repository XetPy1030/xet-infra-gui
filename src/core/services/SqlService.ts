import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ProxyView } from '../domain/proxy'
import type { SessionInfo } from '../domain/session'
import { classifyQuery, tunnelBlocker, type SqlHistoryEntry } from '../domain/sql'
import type { DbProxyPreset, EnvId, SqlConfig } from '../modules/teleport/types'
import type { Clock } from '../ports/Clock'
import { systemClock } from '../ports/Clock'
import type { Logger } from '../ports/Logger'
import type { SqlConnection, SqlDriver, SqlErrorInfo } from '../ports/SqlDriver'
import type { TextStore } from '../ports/TextStore'
import type { SessionManager } from './SessionManager'

/** Куда можно выполнить запрос: db-пресет + его туннель (docs/02 §3 «SQL»). */
export interface SqlTarget {
  presetId: string
  /** Подпись = dbName пресета: dev / stage / prod-replica / prod. */
  label: string
  env: EnvId
  dbUser: string
  dbName: string
  port: number
  /** Боевая база: мутирующие запросы — только с подтверждением (US-14). */
  dangerous: boolean
}

/** Статика SQL-раздела: пресеты и лимиты из конфига (применяются на старте). */
export interface SqlStateView {
  targets: SqlTarget[]
  dumps: { id: string; title: string }[]
  statementTimeoutMs: number
  maxRows: number
}

export type SqlExecResult =
  | {
      ok: true
      columns: string[]
      rows: (string | null)[][]
      /** Строк по мнению сервера (для UPDATE/INSERT — затронуто, не показано). */
      rowCount: number
      command: string | null
      ms: number
      /** Показаны не все строки: сработал лимит maxRows (подсказка про LIMIT). */
      truncated: boolean
      /** Запрос выполнен в read-only транзакции (боевая база без подтверждения). */
      readOnly: boolean
    }
  | {
      ok: false
      /**
       * `no-tunnel` — UI предлагает включить прокси; `needs-confirm` — мутирующий
       * запрос на боевой базе, повторить с `confirmed`; `failed` — ошибка сервера.
       */
      reason: 'unknown-preset' | 'no-tunnel' | 'needs-confirm' | 'failed'
      error: string
      /** Позиция в тексте запроса, если сервер её указал (1-based). */
      position?: number | null
      code?: string | null
    }

export type SqlSessionResult =
  | { ok: true; session: SessionInfo }
  | { ok: false; reason: 'unknown-preset' | 'no-tunnel'; error: string }

/** Хранимая история: loose-разбор — битый файл не должен ронять раздел. */
const historyEntrySchema = z.object({
  id: z.string(),
  presetId: z.string(),
  query: z.string(),
  at: z.number(),
  ms: z.number().nullable().catch(null),
  rowCount: z.number().nullable().catch(null),
  error: z.string().nullable().catch(null)
})

const CONNECT_TIMEOUT_MS = 5000
/** Запас клиентского таймаута над серверным: сначала должен сработать сервер. */
const QUERY_TIMEOUT_SLACK_MS = 5000
/** Хост туннеля: именно 127.0.0.1 — `localhost` может уехать в ::1, где tsh не слушает. */
const TUNNEL_HOST = '127.0.0.1'

/**
 * SQL-консоль (M3, FR-Q1…Q4): запросы через драйвер `pg` в поднятый туннель
 * DB-прокси, история на диске, `psql` в терминале и `SELECT 1` как расширенный
 * health-check туннеля для ProxySupervisor.
 *
 * Соединение живёт ровно один запрос (ADR-0009): при стратегии портов `shared`
 * один и тот же `127.0.0.1:port` после переключения тумблера ведёт уже в другую
 * базу — переиспользованное соединение молча отвечало бы из прошлой.
 */
export class SqlService {
  private history: SqlHistoryEntry[]

  constructor(
    private readonly presets: DbProxyPreset[],
    private readonly cfg: SqlConfig,
    private readonly proxies: () => ProxyView[],
    private readonly driver: SqlDriver,
    private readonly sessions: SessionManager,
    private readonly store: TextStore,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock
  ) {
    this.history = this.loadHistory()
  }

  state(): SqlStateView {
    return {
      targets: this.presets.map((p) => ({
        presetId: p.id,
        label: p.dbName,
        env: p.env,
        dbUser: p.dbUser,
        dbName: p.dbName,
        port: p.port,
        dangerous: p.dangerous
      })),
      dumps: this.cfg.dumpPresets.map((d) => ({ id: d.id, title: d.title })),
      statementTimeoutMs: this.cfg.statementTimeoutMs,
      maxRows: this.cfg.maxRows
    }
  }

  historyList(): SqlHistoryEntry[] {
    return [...this.history]
  }

  clearHistory(): void {
    this.history = []
    this.persistHistory()
  }

  /**
   * Выполнить запрос (FR-Q1). На боевой базе (`dangerous`) без подтверждения
   * запрос идёт в read-only транзакции: эвристика `classifyQuery` решает, когда
   * спросить, а сама защита — на стороне PostgreSQL, а не регулярки.
   */
  async exec(req: { presetId: string; query: string; confirmed?: boolean }): Promise<SqlExecResult> {
    const preset = this.presets.find((p) => p.id === req.presetId)
    if (!preset) {
      return { ok: false, reason: 'unknown-preset', error: `Пресет «${req.presetId}» не найден` }
    }
    const tunnel = this.tunnelError(preset)
    if (tunnel) return { ok: false, reason: 'no-tunnel', error: tunnel }

    const confirmed = req.confirmed === true
    if (preset.dangerous && !confirmed && classifyQuery(req.query) === 'write') {
      return {
        ok: false,
        reason: 'needs-confirm',
        error: `Запрос меняет данные боевой базы «${preset.dbName}» — нужно подтверждение.`
      }
    }
    const readOnly = preset.dangerous && !confirmed

    const opened = await this.connect(preset)
    if (!opened.ok) {
      this.remember(preset.id, req.query, null, null, opened.error.message)
      return { ok: false, reason: 'failed', error: opened.error.message, code: opened.error.code }
    }
    const conn = opened.connection
    try {
      const prepared = await this.prepare(conn, readOnly)
      if (prepared) {
        this.remember(preset.id, req.query, null, null, prepared.message)
        return { ok: false, reason: 'failed', error: prepared.message, code: prepared.code }
      }

      const startedAt = this.clock.now()
      const res = await conn.query(req.query)
      const ms = this.clock.now() - startedAt
      if (!res.ok) {
        this.remember(preset.id, req.query, ms, null, res.error.message)
        return {
          ok: false,
          reason: 'failed',
          error: describeError(res.error),
          position: res.error.position,
          code: res.error.code
        }
      }
      const truncated = res.result.rows.length > this.cfg.maxRows
      this.remember(preset.id, req.query, ms, res.result.rowCount, null)
      return {
        ok: true,
        columns: res.result.columns,
        rows: truncated ? res.result.rows.slice(0, this.cfg.maxRows) : res.result.rows,
        rowCount: res.result.rowCount,
        command: res.result.command,
        ms,
        truncated,
        readOnly
      }
    } finally {
      await conn.close()
    }
  }

  /**
   * Расширенный health-check туннеля (FR-D3): `SELECT 1` доходит до самой базы,
   * тогда как TCP-probe ProxySupervisor'а видит лишь открытый локальный порт.
   * Состояние прокси здесь НЕ проверяется — вызывает как раз тот, кто его ведёт.
   */
  async probe(presetId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const preset = this.presets.find((p) => p.id === presetId)
    if (!preset) return { ok: false, error: `Пресет «${presetId}» не найден` }
    const opened = await this.connect(preset)
    if (!opened.ok) return { ok: false, error: opened.error.message }
    try {
      const res = await opened.connection.query('select 1')
      return res.ok ? { ok: true } : { ok: false, error: res.error.message }
    } finally {
      await opened.connection.close()
    }
  }

  /** `psql` в интегрированном терминале (FR-Q4): тот же туннель, живой интерактив. */
  openPsql(presetId: string): SqlSessionResult {
    const preset = this.presets.find((p) => p.id === presetId)
    if (!preset) {
      return { ok: false, reason: 'unknown-preset', error: `Пресет «${presetId}» не найден` }
    }
    const tunnel = this.tunnelError(preset)
    if (tunnel) return { ok: false, reason: 'no-tunnel', error: tunnel }
    const session = this.sessions.start({
      title: `psql: ${preset.dbName}`,
      cmd: this.cfg.psqlPath,
      args: [
        '-U',
        preset.dbUser,
        '-h',
        TUNNEL_HOST,
        '-p',
        String(preset.port),
        preset.dbName
      ],
      // psql — интерактив: ответы терминала (позиция курсора, фон) ему нужны
      sanitizeTerminalReports: false
    })
    return { ok: true, session }
  }

  /** null — туннель готов; иначе текст для баннера «включить прокси?». */
  private tunnelError(preset: DbProxyPreset): string | null {
    return tunnelBlocker(
      this.proxies().find((p) => p.presetId === preset.id),
      preset.dbName
    )
  }

  private connect(
    preset: DbProxyPreset
  ): ReturnType<SqlDriver['connect']> {
    return this.driver.connect({
      host: TUNNEL_HOST,
      port: preset.port,
      user: preset.dbUser,
      database: preset.dbName,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      queryTimeoutMs:
        this.cfg.statementTimeoutMs > 0 ?
          this.cfg.statementTimeoutMs + QUERY_TIMEOUT_SLACK_MS
        : undefined
    })
  }

  /** statement_timeout и read-only режим — до самого запроса, на том же соединении. */
  private async prepare(conn: SqlConnection, readOnly: boolean): Promise<SqlErrorInfo | null> {
    if (this.cfg.statementTimeoutMs > 0) {
      const res = await conn.query(`set statement_timeout = ${this.cfg.statementTimeoutMs}`)
      if (!res.ok) return res.error
    }
    if (readOnly) {
      // транзакцию не закрываем: close() соединения откатит её вместе с сессией
      const res = await conn.query('begin read only')
      if (!res.ok) return res.error
    }
    return null
  }

  private remember(
    presetId: string,
    query: string,
    ms: number | null,
    rowCount: number | null,
    error: string | null
  ): void {
    if (this.cfg.historyLimit === 0) return
    this.history.unshift({
      id: randomUUID(),
      presetId,
      query,
      at: this.clock.now(),
      ms,
      rowCount,
      error
    })
    if (this.history.length > this.cfg.historyLimit) {
      this.history.length = this.cfg.historyLimit
    }
    this.persistHistory()
  }

  private loadHistory(): SqlHistoryEntry[] {
    const text = this.store.read()
    if (text === null) return []
    try {
      const parsed = z.array(historyEntrySchema).safeParse(JSON.parse(text))
      if (parsed.success) return parsed.data
      this.logger.warn(`История SQL не разобрана (${this.store.path}), начинаю с пустой`)
    } catch (e) {
      this.logger.warn(`История SQL не читается (${this.store.path})`, e)
    }
    return []
  }

  private persistHistory(): void {
    try {
      this.store.write(JSON.stringify(this.history, null, 2) + '\n')
    } catch (e) {
      // история — удобство, а не данные пользователя: молча терять её нельзя,
      // но и запрос из-за неё валить незачем
      this.logger.warn(`История SQL не сохранена (${this.store.path})`, e)
    }
  }
}

/** Сообщение сервера + то, что он добавил к нему (docs/02 §7: ошибки читаемо). */
function describeError(e: SqlErrorInfo): string {
  const parts = [e.message]
  if (e.detail) parts.push(e.detail)
  if (e.hint) parts.push(`Подсказка: ${e.hint}`)
  return parts.join('\n')
}
