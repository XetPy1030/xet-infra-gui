import { describe, expect, it } from 'vitest'
import { stripTerminalReports } from './terminalInput'

describe('stripTerminalReports', () => {
  it('вырезает CPR и OSC-ответ (реальный мусор от xterm при логине tsh)', () => {
    const junk = '\x1b]11;rgb:1212/1616/1c1c\x1b\\\x1b[1;1R'
    expect(stripTerminalReports(junk)).toBe('')
  })

  it('вырезает мусор, но сохраняет введённый следом пароль', () => {
    expect(stripTerminalReports('\x1b[1;1RAkr0iD\r')).toBe('Akr0iD\r')
  })

  it('вырезает DA/DSR-ответы', () => {
    expect(stripTerminalReports('\x1b[?62;c\x1b[0n')).toBe('')
  })

  it('НЕ трогает обычный ввод и стрелки (их шлёт клавиатура)', () => {
    expect(stripTerminalReports('ls -la\r')).toBe('ls -la\r')
    expect(stripTerminalReports('\x1b[A\x1b[B\x1b[C\x1b[D')).toBe('\x1b[A\x1b[B\x1b[C\x1b[D')
    expect(stripTerminalReports('\x1b[200~paste\x1b[201~')).toBe('\x1b[200~paste\x1b[201~')
  })

  it('пустой и обычный текст', () => {
    expect(stripTerminalReports('')).toBe('')
    expect(stripTerminalReports('123456\r')).toBe('123456\r')
  })
})
