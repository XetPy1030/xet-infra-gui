import pg from 'pg'
import type { Logger } from '@core/ports/Logger'
import type {
  SqlConnectOptions,
  SqlConnection,
  SqlDriver,
  SqlErrorInfo,
  SqlQueryResult
} from '@core/ports/SqlDriver'

const { Client } = pg

/** Имя видно в `pg_stat_activity` — понятно, чьё соединение висит на сервере. */
const APP_NAME = 'xet-infra-gui'
/** SQLSTATE — ровно пять символов; всё остальное (ECONNREFUSED) не от сервера. */
const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * Драйвер `pg` в туннель DB-прокси (docs/04 §3.4). Пароля нет: `tsh proxy db
 * --tunnel` уже аутентифицирован, соединение локальное — TLS не нужен.
 *
 * Значения приводятся к строкам здесь: в таблице результатов и в IPC всё равно
 * поедет текст, а Date/Buffer/json по дороге превратились бы в `[object Object]`.
 */
export class PgSqlDriver implements SqlDriver {
  constructor(private readonly logger: Logger) {}

  async connect(
    opts: SqlConnectOptions
  ): Promise<{ ok: true; connection: SqlConnection } | { ok: false; error: SqlErrorInfo }> {
    const client = new Client({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      database: opts.database,
      application_name: APP_NAME,
      connectionTimeoutMillis: opts.connectTimeoutMs,
      query_timeout: opts.queryTimeoutMs,
      ssl: false
    })
    // без обработчика 'error' разрыв соединения между запросами уронил бы
    // весь main как unhandled error на EventEmitter
    client.on('error', (e) => this.logger.warn('pg: соединение потеряно', e))
    try {
      await client.connect()
    } catch (e) {
      await client.end().catch(() => undefined)
      return { ok: false, error: describe(e, opts) }
    }
    return { ok: true, connection: new PgConnection(client, opts, this.logger) }
  }
}

class PgConnection implements SqlConnection {
  constructor(
    private readonly client: pg.Client,
    private readonly opts: SqlConnectOptions,
    private readonly logger: Logger
  ) {}

  async query(
    sql: string
  ): Promise<{ ok: true; result: SqlQueryResult } | { ok: false; error: SqlErrorInfo }> {
    try {
      const res = await this.client.query({ text: sql, rowMode: 'array' })
      // несколько выражений через `;` → массив результатов: показываем последний,
      // как это делает psql
      const last = Array.isArray(res) ? res[res.length - 1] : res
      if (!last) return { ok: true, result: { columns: [], rows: [], rowCount: 0, command: null } }
      return {
        ok: true,
        result: {
          columns: (last.fields ?? []).map((f: pg.FieldDef) => f.name),
          rows: (last.rows as unknown[][]).map((row) => row.map(cell)),
          rowCount: last.rowCount ?? last.rows.length,
          command: last.command || null
        }
      }
    } catch (e) {
      return { ok: false, error: describe(e, this.opts) }
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.end()
    } catch (e) {
      this.logger.warn('pg: соединение не закрылось штатно', e)
    }
  }
}

/** Значение ячейки → текст; null остаётся null (это не строка «null»). */
function cell(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Ошибка драйвера в вид, пригодный для UI. Отдельно — сетевые: «ECONNREFUSED»
 * пользователю ничего не говорит, а «туннель не отвечает» говорит (docs/02 §7).
 */
function describe(e: unknown, opts: SqlConnectOptions): SqlErrorInfo {
  const err = e as Partial<pg.DatabaseError> & { code?: string; message?: string }
  const code = typeof err.code === 'string' ? err.code : null
  const target = `${opts.host}:${opts.port}`
  if (code && !SQLSTATE.test(code)) {
    const reason =
      code === 'ECONNREFUSED' ? 'туннель не слушает порт'
      : code === 'ECONNRESET' ? 'туннель разорвал соединение'
      : code === 'ETIMEDOUT' ? 'туннель не ответил вовремя'
      : err.message ?? code
    return {
      message: `Не удалось подключиться к ${target}: ${reason} (${code}).`,
      code: null,
      position: null,
      detail: null,
      hint: 'Проверь, поднят ли прокси этого пресета.'
    }
  }
  return {
    message: err.message ?? String(e),
    code,
    position: err.position ? Number(err.position) : null,
    detail: err.detail ?? null,
    hint: err.hint ?? null
  }
}
