import type { ProxyView } from './proxy'

/**
 * Доменная модель SQL-консоли (M3). Здесь только чистые функции и типы: разбор
 * запроса глазами пользователя (мутирующий ли он, есть ли LIMIT) и форма
 * результата/истории, которые едут в UI по IPC.
 */

/**
 * Почему по туннелю сейчас нельзя ходить; null — можно. Одна формулировка на
 * консоль и на дампы: и тем и другим нужен один и тот же поднятый прокси.
 */
export function tunnelBlocker(view: ProxyView | undefined, label: string): string | null {
  if (!view || view.state === 'off') return `Туннель «${label}» не поднят — включи прокси.`
  if (view.state === 'healthy') return null
  if (view.state === 'error') return view.error ?? `Прокси «${label}» в ошибке.`
  return `Туннель «${label}» ещё не готов (${view.state}).`
}

/** Подстановки в шаблонах пресетов дампа: `{port}`, `{dbName}`… (FR-Q5). */
export function expandTemplate(template: string, vars: Record<string, string>): string {
  // неизвестные `{…}` остаются как есть: команда идёт в sh, и там свои скобки
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole)
}

/**
 * Мутирующий ли запрос. Эвристика (FR-Q3), а не парсер: она решает, спрашивать
 * ли подтверждение, поэтому её ошибка должна быть в сторону «спросить лишний
 * раз». Настоящая защита боевой базы — read-only транзакция в SqlService.
 */
export type QueryKind = 'read' | 'write'

/** Команды, после которых база остаётся прежней. Всё остальное — 'write'. */
const READ_HEADS = new Set([
  'select',
  'table',
  'values',
  'show',
  'explain',
  'analyse',
  'analyze',
  'fetch',
  'declare',
  'close',
  'discard',
  'reset'
])

const WRITE_ANYWHERE = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke)\b/

/**
 * Убирает то, внутри чего ключевые слова ничего не значат: комментарии,
 * строковые литералы и закавыченные идентификаторы. Иначе
 * `select 'delete from users'` уехал бы в мутирующие.
 */
function stripSqlNoise(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
    } else if (two === '/*') {
      // вложенные блочные комментарии — легальный PostgreSQL
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth += 1
          i += 2
        } else if (sql.startsWith('*/', i)) {
          depth -= 1
          i += 2
        } else i += 1
      }
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]
      i += 1
      while (i < sql.length) {
        if (sql[i] === quote) {
          // '' внутри литерала — экранированная кавычка, литерал продолжается
          if (sql[i + 1] === quote) i += 2
          else {
            i += 1
            break
          }
        } else i += 1
      }
      out += ' '
    } else {
      out += sql[i]
      i += 1
    }
  }
  return out
}

const firstWord = (sql: string): string => (/[a-z_]+/i.exec(sql.trimStart())?.[0] ?? '').toLowerCase()

/** Одно выражение из пачки; `;` внутри литералов уже вырезан stripSqlNoise. */
const statements = (clean: string): string[] =>
  clean
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

export function classifyQuery(sql: string): QueryKind {
  const clean = stripSqlNoise(sql)
  return statements(clean).some((s) => classifyOne(s)) ? 'write' : 'read'
}

/** true — выражение меняет данные или схему. */
function classifyOne(statement: string): boolean {
  const head = firstWord(statement)
  if (head === 'with') {
    // CTE может заканчиваться INSERT/UPDATE/DELETE — тогда это запись
    return WRITE_ANYWHERE.test(statement.toLowerCase())
  }
  if (head === 'explain') {
    // EXPLAIN ANALYZE выполняет запрос по-настоящему
    const lower = statement.toLowerCase()
    return /\banalyz[es]\b/.test(lower) && WRITE_ANYWHERE.test(lower)
  }
  return !READ_HEADS.has(head)
}

/** Запись истории (FR-Q2): хранится на диске, привязана к пресету туннеля. */
export interface SqlHistoryEntry {
  id: string
  presetId: string
  query: string
  at: number
  /** Длительность выполнения; null — запрос не дошёл до сервера. */
  ms: number | null
  /** Строк вернулось/затронуто; null — была ошибка. */
  rowCount: number | null
  /** Текст ошибки — чтобы из истории было видно, чем кончилось. */
  error: string | null
}
