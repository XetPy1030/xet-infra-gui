import { describe, expect, it } from 'vitest'
import { ageOf, humanAge } from './age'

const s = 1000
const m = 60 * s
const h = 60 * m
const d = 24 * h

describe('humanAge (формат kubectl)', () => {
  it('секунды до двух минут', () => {
    expect(humanAge(45 * s)).toBe('45s')
    expect(humanAge(119 * s)).toBe('119s')
  })

  it('минуты: до 10 — с секундами, дальше только минуты', () => {
    expect(humanAge(2 * m)).toBe('2m')
    expect(humanAge(3 * m + 12 * s)).toBe('3m12s')
    expect(humanAge(12 * m + 30 * s)).toBe('12m')
    expect(humanAge(179 * m)).toBe('179m')
  })

  it('часы: до 8 — с минутами, дальше только часы', () => {
    expect(humanAge(3 * h + 29 * m)).toBe('3h29m')
    expect(humanAge(5 * h)).toBe('5h')
    expect(humanAge(30 * h)).toBe('30h')
  })

  it('дни: до 8 — с часами, дальше только дни', () => {
    expect(humanAge(6 * d + 1 * h)).toBe('6d1h')
    expect(humanAge(60 * d)).toBe('60d')
  })

  it('отрицательное (часы машины разъехались) → 0s, не «<invalid>»', () => {
    expect(humanAge(-5 * s)).toBe('0s')
  })
})

describe('ageOf', () => {
  it('считает от ISO-таймстампа пода', () => {
    const now = Date.parse('2026-07-30T16:00:00+04:00') // = 12:00:00Z
    expect(ageOf('2026-07-30T08:31:12Z', now)).toBe('3h28m')
    expect(ageOf('2026-07-24T04:15:00Z', now)).toBe('6d7h')
  })

  it('нет времени / мусор → прочерк', () => {
    expect(ageOf(null, Date.now())).toBe('—')
    expect(ageOf('не-дата', Date.now())).toBe('—')
  })
})
