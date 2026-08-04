import { describe, expect, it } from 'vitest'
import { formatAccelerator, matchesAccelerator, type KeyPress } from './accelerator'

const press = (over: Partial<KeyPress> & { key: string }): KeyPress => ({
  code: undefined,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over
})

describe('разбор сочетания', () => {
  it('модификаторы и клавиша совпадают целиком', () => {
    const chord = press({ key: 'i', code: 'KeyI', metaKey: true, altKey: true })
    expect(matchesAccelerator(chord, 'Alt+Command+I')).toBe(true)
    expect(matchesAccelerator(chord, 'Command+I')).toBe(false)
  })

  it('мусор не совпадает ни с чем и показывается как есть', () => {
    const chord = press({ key: 'a', metaKey: true })
    for (const bad of ['', 'Command+Shift', 'A+B']) {
      expect(matchesAccelerator(chord, bad)).toBe(false)
      expect(formatAccelerator(bad)).toBe(bad)
    }
  })
})

describe('matchesAccelerator', () => {
  it('совпадает по клавише и модификаторам', () => {
    expect(matchesAccelerator(press({ key: 'k', metaKey: true }), 'CommandOrControl+K')).toBe(true)
    expect(matchesAccelerator(press({ key: 'k', ctrlKey: true }), 'CommandOrControl+K')).toBe(true)
    expect(matchesAccelerator(press({ key: 'k' }), 'CommandOrControl+K')).toBe(false)
  })

  it('лишний модификатор — не то сочетание', () => {
    expect(
      matchesAccelerator(press({ key: 'k', metaKey: true, shiftKey: true }), 'CommandOrControl+K')
    ).toBe(false)
  })

  it('с Alt на macOS key превращается в символ — спасает code', () => {
    // ⌥⌘I даёт key='ˆ', и без code сочетание было бы не узнать
    expect(
      matchesAccelerator(
        press({ key: 'ˆ', code: 'KeyI', metaKey: true, altKey: true }),
        'Alt+Command+I'
      )
    ).toBe(true)
  })

  it('цифры окружений ловятся и по code', () => {
    expect(
      matchesAccelerator(press({ key: '1', code: 'Digit1', metaKey: true }), 'CommandOrControl+1')
    ).toBe(true)
  })
})

describe('formatAccelerator', () => {
  it('показывает символами macOS', () => {
    expect(formatAccelerator('Alt+Command+I')).toBe('⌥⌘I')
    expect(formatAccelerator('CommandOrControl+K')).toBe('⌘K')
  })
})
