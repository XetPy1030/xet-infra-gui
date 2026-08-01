import { describe, expect, it } from 'vitest'
import { replaySlice } from './stream'

describe('replaySlice — дедуп потока при восстановлении xterm', () => {
  it('чанк целиком за watermark — пишется как есть', () => {
    expect(replaySlice(10, { data: 'abc', end: 13 })).toEqual({ text: 'abc', written: 13 })
  })

  it('чанк целиком до watermark (уже в снапшоте) — отбрасывается', () => {
    expect(replaySlice(20, { data: 'abc', end: 13 })).toBeNull()
    // граница: конец ровно на watermark — тоже уже показан
    expect(replaySlice(13, { data: 'abc', end: 13 })).toBeNull()
  })

  it('чанк пересекает watermark — пишется только правый хвост', () => {
    // поток …[10..16], снапшот покрыл до 13 → дописываем только [13..16]
    expect(replaySlice(13, { data: 'abcdef', end: 16 })).toEqual({ text: 'def', written: 16 })
  })

  it('снапшот+живые не дублируются и не рвутся (сценарий гонки)', () => {
    // buffer покрыл поток до cursor=5; очередь живых чанков пришла с пересечением
    let written = 5
    const events = [
      { data: 'XYZ', end: 3 }, // целиком в снапшоте → skip
      { data: 'defg', end: 7 }, // [3..7] пересекает 5 → дописать 'fg'
      { data: 'hi', end: 9 } // [7..9] целиком новый → 'hi'
    ]
    const out: string[] = []
    for (const e of events) {
      const r = replaySlice(written, e)
      if (r) {
        out.push(r.text)
        written = r.written
      }
    }
    expect(out.join('')).toBe('fghi')
    expect(written).toBe(9)
  })
})
