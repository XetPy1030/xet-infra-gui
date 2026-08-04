import { describe, expect, it } from 'vitest'
import type { ProxyRunState, ProxyView } from '../domain/proxy'
import type { DbProxyPreset, SqlConfig } from '../modules/teleport/types'
import { noopLogger } from '../ports/Logger'
import type { PtyFactory, PtyHandle } from '../ports/PtyFactory'
import type { SqlConnectOptions, SqlDriver, SqlErrorInfo, SqlQueryResult } from '../ports/SqlDriver'
import type { TextStore } from '../ports/TextStore'
import { SessionManager } from './SessionManager'
import { SqlService } from './SqlService'

const PRESETS: DbProxyPreset[] = [
  { id: 'db-dev', env: 'dev', tunnel: 'dev-postgres', dbUser: 'app', dbName: 'dev', port: 6432, dangerous: false },
  { id: 'db-prod', env: 'prod', tunnel: 'prod-postgres', dbUser: 'app', dbName: 'prod', port: 6432, dangerous: true }
]

const SQL_CFG: SqlConfig = {
  statementTimeoutMs: 30_000,
  maxRows: 3,
  historyLimit: 3,
  psqlPath: 'psql',
  dumpPresets: [
    { id: 'dump', title: 'pg_dump', command: 'pg_dump {dbName} > {file}', defaultFile: '{dbName}.sql' }
  ]
}

const view = (presetId: string, state: ProxyRunState): ProxyView => ({
  presetId,
  label: presetId,
  env: 'dev',
  port: 6432,
  dangerous: false,
  on: state !== 'off',
  state,
  sessionId: null,
  attempts: 0,
  error: null
})

const rows = (n: number): SqlQueryResult => ({
  columns: ['id'],
  rows: Array.from({ length: n }, (_, i) => [String(i)]),
  rowCount: n,
  command: 'SELECT'
})

const pgError = (over: Partial<SqlErrorInfo> = {}): SqlErrorInfo => ({
  message: 'relation "nope" does not exist',
  code: '42P01',
  position: 15,
  detail: null,
  hint: null,
  ...over
})

class FakePty implements PtyHandle {
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {}
  onData(): void {}
  onExit(): void {}
}

interface FakeOpts {
  /** Ответ на сам запрос пользователя (SET/BEGIN всегда успешны). */
  result?: SqlQueryResult
  queryError?: SqlErrorInfo
  connectError?: SqlErrorInfo
  states?: Record<string, ProxyRunState>
  cfg?: Partial<SqlConfig>
  history?: string | null
}

function setup(opts: FakeOpts = {}) {
  const queries: string[] = []
  const connects: SqlConnectOptions[] = []
  let closes = 0

  const driver: SqlDriver = {
    connect: async (o) => {
      connects.push(o)
      if (opts.connectError) return { ok: false, error: opts.connectError }
      return {
        ok: true,
        connection: {
          query: async (sql: string) => {
            queries.push(sql)
            if (/^(set|begin)\b/i.test(sql)) {
              return { ok: true, result: { columns: [], rows: [], rowCount: 0, command: null } }
            }
            if (opts.queryError) return { ok: false, error: opts.queryError }
            return { ok: true, result: opts.result ?? rows(1) }
          },
          close: async () => {
            closes += 1
          }
        }
      }
    }
  }

  let saved: string | null = opts.history ?? null
  const store: TextStore = {
    path: '/tmp/sql-history.json',
    read: () => saved,
    write: (text) => {
      saved = text
    }
  }

  const spawns: { cmd: string; args: string[]; title: string }[] = []
  const ptyFactory: PtyFactory = {
    spawn: (spec) => {
      spawns.push({ cmd: spec.cmd, args: spec.args, title: spec.title })
      return new FakePty()
    }
  }

  const states: Record<string, ProxyRunState> = opts.states ?? { 'db-dev': 'healthy', 'db-prod': 'healthy' }
  const sql = new SqlService(
    PRESETS,
    { ...SQL_CFG, ...opts.cfg },
    () => Object.entries(states).map(([id, state]) => view(id, state)),
    driver,
    new SessionManager(ptyFactory, noopLogger),
    store,
    noopLogger,
    { now: () => 1000 }
  )
  return { sql, queries, connects, spawns, stats: () => ({ closes }), saved: () => saved }
}

describe('SqlService.exec (FR-Q1)', () => {
  it('туннель не поднят → предлагаем включить прокси, к драйверу не идём', async () => {
    const { sql, connects } = setup({ states: { 'db-dev': 'off' } })
    const res = await sql.exec({ presetId: 'db-dev', query: 'select 1' })
    expect(res).toMatchObject({ ok: false, reason: 'no-tunnel' })
    expect(connects).toEqual([])
  })

  it('туннель ещё поднимается → говорим об этом, а не «не поднят»', async () => {
    const { sql } = setup({ states: { 'db-dev': 'probing' } })
    const res = await sql.exec({ presetId: 'db-dev', query: 'select 1' })
    expect(res).toMatchObject({ ok: false, reason: 'no-tunnel' })
    if (res.ok) return
    expect(res.error).toMatch(/probing/)
  })

  it('happy path: statement_timeout до запроса, соединение закрыто', async () => {
    const { sql, queries, connects, stats } = setup()
    const res = await sql.exec({ presetId: 'db-dev', query: 'select 1' })
    expect(res).toMatchObject({ ok: true, rowCount: 1, command: 'SELECT', truncated: false, readOnly: false })
    expect(queries).toEqual(['set statement_timeout = 30000', 'select 1'])
    expect(connects[0]).toEqual({
      host: '127.0.0.1',
      port: 6432,
      user: 'app',
      database: 'dev',
      connectTimeoutMs: 5000,
      // клиентский предохранитель поверх серверного statement_timeout
      queryTimeoutMs: 35_000
    })
    expect(stats().closes).toBe(1)
  })

  it('соединение живёт один запрос: shared-порт после переключения ведёт в другую базу', async () => {
    const { sql, connects } = setup()
    await sql.exec({ presetId: 'db-dev', query: 'select 1' })
    await sql.exec({ presetId: 'db-prod', query: 'select 1', confirmed: true })
    expect(connects.map((c) => c.database)).toEqual(['dev', 'prod'])
  })

  it('строк больше maxRows → обрезаем и честно говорим об этом (подсказка LIMIT)', async () => {
    const { sql } = setup({ result: rows(10) })
    const res = await sql.exec({ presetId: 'db-dev', query: 'select * from users' })
    expect(res).toMatchObject({ ok: true, truncated: true, rowCount: 10 })
    if (!res.ok) return
    expect(res.rows).toHaveLength(3)
  })

  it('ошибка сервера читаема: message + detail + hint, позиция сохранена', async () => {
    const { sql } = setup({
      queryError: pgError({ detail: 'таблицы нет в схеме public', hint: 'проверь search_path' })
    })
    const res = await sql.exec({ presetId: 'db-dev', query: 'select * from nope' })
    expect(res).toMatchObject({ ok: false, reason: 'failed', code: '42P01', position: 15 })
    if (res.ok) return
    expect(res.error).toBe(
      'relation "nope" does not exist\nтаблицы нет в схеме public\nПодсказка: проверь search_path'
    )
  })

  it('не достучались до туннеля (прокси «жив», а порт молчит) → ошибка, а не пустая таблица', async () => {
    const { sql } = setup({ connectError: { message: 'ECONNREFUSED 127.0.0.1:6432', code: null, position: null, detail: null, hint: null } })
    const res = await sql.exec({ presetId: 'db-dev', query: 'select 1' })
    expect(res).toMatchObject({ ok: false, reason: 'failed', error: 'ECONNREFUSED 127.0.0.1:6432' })
  })

  it('незнакомый пресет → внятный отказ', async () => {
    const { sql } = setup()
    expect(await sql.exec({ presetId: 'нет', query: 'select 1' })).toMatchObject({
      ok: false,
      reason: 'unknown-preset'
    })
  })
})

describe('SqlService: боевая база (US-14, FR-Q3)', () => {
  it('мутирующий запрос без подтверждения не выполняется вовсе', async () => {
    const { sql, connects } = setup()
    const res = await sql.exec({ presetId: 'db-prod', query: 'delete from users' })
    expect(res).toMatchObject({ ok: false, reason: 'needs-confirm' })
    expect(connects).toEqual([])
  })

  it('читающий запрос идёт в read-only транзакции: защита не на регулярке, а в PostgreSQL', async () => {
    const { sql, queries } = setup()
    const res = await sql.exec({ presetId: 'db-prod', query: 'select 1' })
    expect(res).toMatchObject({ ok: true, readOnly: true })
    expect(queries).toEqual(['set statement_timeout = 30000', 'begin read only', 'select 1'])
  })

  it('подтверждённый запрос выполняется без read-only обёртки', async () => {
    const { sql, queries } = setup()
    const res = await sql.exec({ presetId: 'db-prod', query: 'delete from users', confirmed: true })
    expect(res).toMatchObject({ ok: true, readOnly: false })
    expect(queries).toEqual(['set statement_timeout = 30000', 'delete from users'])
  })

  it('на обычной базе ничего не спрашиваем и не оборачиваем', async () => {
    const { sql, queries } = setup()
    const res = await sql.exec({ presetId: 'db-dev', query: 'delete from users' })
    expect(res).toMatchObject({ ok: true, readOnly: false })
    expect(queries).toEqual(['set statement_timeout = 30000', 'delete from users'])
  })

  it('statement_timeout = 0 → не выставляем вовсе', async () => {
    const { sql, queries } = setup({ cfg: { statementTimeoutMs: 0 } })
    await sql.exec({ presetId: 'db-dev', query: 'select 1' })
    expect(queries).toEqual(['select 1'])
  })
})

describe('SqlService: история (FR-Q2)', () => {
  it('пишется на диск, новые сверху, лимит соблюдается', async () => {
    const { sql, saved } = setup()
    for (const q of ['select 1', 'select 2', 'select 3', 'select 4']) {
      await sql.exec({ presetId: 'db-dev', query: q })
    }
    expect(sql.historyList().map((h) => h.query)).toEqual(['select 4', 'select 3', 'select 2'])
    expect(JSON.parse(saved() ?? '[]')).toHaveLength(3)
  })

  it('неудачный запрос тоже попадает в историю — с текстом ошибки', async () => {
    const { sql } = setup({ queryError: pgError() })
    await sql.exec({ presetId: 'db-dev', query: 'select * from nope' })
    expect(sql.historyList()[0]).toMatchObject({
      query: 'select * from nope',
      rowCount: null,
      error: 'relation "nope" does not exist'
    })
  })

  it('битый файл истории не роняет раздел', () => {
    const { sql } = setup({ history: '{не json' })
    expect(sql.historyList()).toEqual([])
  })

  it('файл читается при старте, очистка стирает и диск', async () => {
    const entry = { id: '1', presetId: 'db-dev', query: 'select 1', at: 1, ms: 2, rowCount: 1, error: null }
    const { sql, saved } = setup({ history: JSON.stringify([entry]) })
    expect(sql.historyList()).toHaveLength(1)
    sql.clearHistory()
    expect(sql.historyList()).toEqual([])
    expect(JSON.parse(saved() ?? 'null')).toEqual([])
  })

  it('historyLimit = 0 → историю не ведём', async () => {
    const { sql } = setup({ cfg: { historyLimit: 0 } })
    await sql.exec({ presetId: 'db-dev', query: 'select 1' })
    expect(sql.historyList()).toEqual([])
  })
})

describe('SqlService.probe (FR-D3) и psql (FR-Q4)', () => {
  it('SELECT 1 не смотрит на состояние прокси — его зовёт тот, кто это состояние ведёт', async () => {
    const { sql, queries } = setup({ states: { 'db-dev': 'probing' } })
    expect(await sql.probe('db-dev')).toEqual({ ok: true })
    expect(queries).toEqual(['select 1'])
  })

  it('порт открыт, а база не отвечает → probe честно падает', async () => {
    const { sql } = setup({ queryError: pgError({ message: 'terminating connection' }) })
    expect(await sql.probe('db-dev')).toEqual({ ok: false, error: 'terminating connection' })
  })

  it('psql в терминале: дословная команда в 127.0.0.1 (localhost уехал бы в ::1)', () => {
    const { sql, spawns } = setup()
    const res = sql.openPsql('db-dev')
    expect(res.ok).toBe(true)
    expect(spawns[0]).toEqual({
      cmd: 'psql',
      args: ['-U', 'app', '-h', '127.0.0.1', '-p', '6432', 'dev'],
      title: 'psql: dev'
    })
  })

  it('psql без туннеля не запускается', () => {
    const { sql, spawns } = setup({ states: { 'db-dev': 'off' } })
    expect(sql.openPsql('db-dev')).toMatchObject({ ok: false, reason: 'no-tunnel' })
    expect(spawns).toEqual([])
  })
})
