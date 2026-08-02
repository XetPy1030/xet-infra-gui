/**
 * Порт SQL-драйвера (M3): всё, что нужно консоли от PostgreSQL. Реализация —
 * `pg` в main (адаптер PgSqlDriver); core про драйвер и его типы не знает.
 *
 * Значения приходят уже строками: таблица результатов их только рисует, а по
 * IPC всё равно поехал бы JSON — приводить типы дважды незачем.
 */

export interface SqlConnectOptions {
  host: string
  port: number
  user: string
  database: string
  connectTimeoutMs: number
  /**
   * Клиентский предохранитель поверх серверного `statement_timeout`: если
   * туннель завис на уровне сети, сервер о таймауте не узнает, и без этого
   * запрос висел бы вечно (а с ним — спиннер в UI).
   */
  queryTimeoutMs?: number
}

export interface SqlQueryResult {
  columns: string[]
  /** null — SQL NULL (в отличие от строки 'null'). */
  rows: (string | null)[][]
  /** Затронуто строк по мнению сервера: для INSERT/UPDATE это не длина rows. */
  rowCount: number
  /** Тег команды: SELECT / UPDATE / CREATE TABLE… — то же, что печатает psql. */
  command: string | null
}

/** Ошибка выполнения, разобранная до человекочитаемого вида (docs/02 §7). */
export interface SqlErrorInfo {
  message: string
  /** Код PostgreSQL (`42P01` и т.п.); null — ошибка не от сервера (сеть, таймаут). */
  code: string | null
  /** Позиция в тексте запроса (1-based), если сервер её указал. */
  position: number | null
  detail: string | null
  hint: string | null
}

export interface SqlConnection {
  /** Никогда не reject'ится: ошибки приходят разобранными в SqlErrorInfo. */
  query(sql: string): Promise<{ ok: true; result: SqlQueryResult } | { ok: false; error: SqlErrorInfo }>
  close(): Promise<void>
}

export interface SqlDriver {
  connect(
    opts: SqlConnectOptions
  ): Promise<{ ok: true; connection: SqlConnection } | { ok: false; error: SqlErrorInfo }>
}
