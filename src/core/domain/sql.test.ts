import { describe, expect, it } from 'vitest'
import type { ProxyView } from './proxy'
import { classifyQuery, expandTemplate, tunnelBlocker } from './sql'

describe('classifyQuery (FR-Q3)', () => {
  it('чтение — это select/with-select/explain/show', () => {
    expect(classifyQuery('select * from users')).toBe('read')
    expect(classifyQuery('  SELECT 1  ')).toBe('read')
    expect(classifyQuery('with x as (select 1) select * from x')).toBe('read')
    expect(classifyQuery('explain select * from users')).toBe('read')
    expect(classifyQuery('show statement_timeout')).toBe('read')
    expect(classifyQuery('table users')).toBe('read')
  })

  it('запись — не только update/delete, но и DDL и права', () => {
    for (const q of [
      'update users set name = 1',
      'DELETE FROM users',
      'insert into users values (1)',
      'truncate users',
      'drop table users',
      'alter table users add column x int',
      'grant select on users to bob',
      'vacuum full users'
    ]) {
      expect(classifyQuery(q), q).toBe('write')
    }
  })

  it('мутирующий CTE не прячется за словом with', () => {
    expect(classifyQuery('with d as (delete from users returning *) select * from d')).toBe('write')
  })

  it('EXPLAIN ANALYZE выполняет запрос по-настоящему', () => {
    expect(classifyQuery('explain analyze delete from users')).toBe('write')
    expect(classifyQuery('explain (analyze, buffers) update users set x = 1')).toBe('write')
    expect(classifyQuery('explain delete from users')).toBe('read')
  })

  it('ключевые слова внутри литералов и комментариев не считаются', () => {
    expect(classifyQuery("select 'delete from users' as t")).toBe('read')
    expect(classifyQuery('select 1 -- delete from users')).toBe('read')
    expect(classifyQuery('/* update users */ select 1')).toBe('read')
    expect(classifyQuery("select 'it''s delete' from t")).toBe('read')
  })

  it('пачка выражений: мутирующим считается всё, если мутирует хотя бы одно', () => {
    expect(classifyQuery('select 1; delete from users;')).toBe('write')
    expect(classifyQuery('select 1; select 2;')).toBe('read')
    expect(classifyQuery("select ';delete from t;'")).toBe('read')
  })

  it('неизвестное слово — на сторону «спросить лишний раз»', () => {
    expect(classifyQuery('call do_something()')).toBe('write')
    expect(classifyQuery('')).toBe('read')
  })
})

describe('expandTemplate (FR-Q5)', () => {
  it('подставляет известное, чужие скобки не трогает', () => {
    expect(
      expandTemplate('pg_dump -U {dbUser} -p {port} {dbName} > {file} ${HOME}/{unknown}', {
        dbUser: 'app',
        port: '6432',
        dbName: 'dev',
        file: '/tmp/d.sql'
      })
    ).toBe('pg_dump -U app -p 6432 dev > /tmp/d.sql ${HOME}/{unknown}')
  })
})

describe('tunnelBlocker', () => {
  const view = (state: ProxyView['state'], error: string | null = null): ProxyView => ({
    presetId: 'db-dev',
    label: 'dev',
    env: 'dev',
    port: 6432,
    dangerous: false,
    state,
    sessionId: null,
    attempts: 0,
    error
  })

  it('healthy — путь открыт', () => {
    expect(tunnelBlocker(view('healthy'), 'dev')).toBeNull()
  })

  it('прокси нет или выключена — предлагаем включить', () => {
    expect(tunnelBlocker(undefined, 'dev')).toMatch(/не поднят/)
    expect(tunnelBlocker(view('off'), 'dev')).toMatch(/не поднят/)
  })

  it('ошибка прокси доезжает до пользователя как есть', () => {
    expect(tunnelBlocker(view('error', 'Порт 6432 занят'), 'dev')).toBe('Порт 6432 занят')
  })

  it('промежуточные состояния названы честно, а не «не поднят»', () => {
    expect(tunnelBlocker(view('probing'), 'dev')).toMatch(/ещё не готов \(probing\)/)
  })
})
