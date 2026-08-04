import { describe, expect, it } from 'vitest'
import { fuzzyFilter } from './fuzzy'

/** Порядок и состав результата — единственное, что видит палитра. */
const filter = (query: string, items: string[]): string[] =>
  fuzzyFilter(query, items, (s) => s)

describe('fuzzyFilter', () => {
  it('находит подпоследовательность и отбрасывает несовпадение', () => {
    expect(filter('bsh', ['Bash → api (dev)'])).toEqual(['Bash → api (dev)'])
    expect(filter('bshx', ['Bash → api (dev)'])).toEqual([])
  })

  it('термины ищутся в любом порядке', () => {
    const rows = ['Bash → api (dev)']
    expect(filter('bash api', rows)).toEqual(rows)
    expect(filter('api bash', rows)).toEqual(rows)
  })

  it('пустой запрос сохраняет порядок реестра', () => {
    const rows = ['Teleport: перелогин', 'SQL: консоль dev']
    expect(filter('   ', rows)).toEqual(rows)
  })

  it('ё и е — одна буква', () => {
    expect(filter('ещё', ['еще раз'])).toEqual(['еще раз'])
    expect(filter('еще', ['ещё раз'])).toEqual(['ещё раз'])
  })

  it('совпадение с начала слова выше, чем из середины', () => {
    expect(filter('rep', ['SQL: консоль prod-replica', 'Teleport: перелогин'])[0]).toBe(
      'SQL: консоль prod-replica'
    )
  })

  it('короткая подпись при равном совпадении выше длинной', () => {
    expect(filter('sql', ['SQL: консоль prod-replica', 'SQL: dev'])[0]).toBe('SQL: dev')
  })

  it('слово целиком выше буквенной россыпи по ключевым словам', () => {
    // живой прогон: «прокси prod» ставил «включить dev» первым, потому что
    // p-r-o нашлись в слове «proxy», а d — в «dev» (ключевые слова действия)
    const rows = [
      'DB-прокси: включить dev proxy tunnel туннель dev порт 6432',
      'DB-прокси: включить prod proxy tunnel туннель prod порт 6432'
    ]
    expect(filter('прокси prod', rows)[0]).toContain('включить prod')
  })
})
