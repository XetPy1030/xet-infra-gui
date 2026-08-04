/**
 * Хоткеи в формате акселераторов Electron (`Alt+Command+I`, `CommandOrControl+K`).
 * Один формат на глобальные (их регистрирует main через `globalShortcut`) и на
 * внутренние (их ловит renderer): пользователь правит те и другие в одной секции
 * конфига и не должен помнить два синтаксиса.
 */

interface Accelerator {
  /** Command/Meta обязателен. */
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** `CommandOrControl`: подойдёт любая из двух — на маке Command, иначе Control. */
  metaOrCtrl: boolean
  /** Верхний регистр: `K`, `1`, `ENTER`. */
  key: string
}

/** Как выглядит нажатие для сравнения: подмножество KeyboardEvent. */
export interface KeyPress {
  key: string
  /** Физическая клавиша (`KeyK`, `Digit1`): с Alt на macOS `key` уже не буква. */
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

type ModifierKey = Exclude<keyof Accelerator, 'key'>

const MODIFIERS: Record<string, ModifierKey> = {
  command: 'meta',
  cmd: 'meta',
  meta: 'meta',
  super: 'meta',
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  commandorcontrol: 'metaOrCtrl',
  cmdorctrl: 'metaOrCtrl'
}

/** null — строка не разбирается (пустая, без клавиши или из одних модификаторов). */
function parseAccelerator(accel: string): Accelerator | null {
  const parts = accel.split('+').map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const acc: Accelerator = {
    meta: false,
    ctrl: false,
    alt: false,
    shift: false,
    metaOrCtrl: false,
    key: ''
  }
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()]
    if (mod) {
      acc[mod] = true
      continue
    }
    // клавиша только одна: «A+B» — опечатка, а не аккорд
    if (acc.key !== '') return null
    acc.key = part.toUpperCase()
  }
  return acc.key === '' ? null : acc
}

/** Имя клавиши нажатия в терминах акселератора (`k`→`K`, `KeyK`→`K`, `Digit1`→`1`). */
function pressedKey(e: KeyPress): string[] {
  const names = [e.key.toUpperCase()]
  const code = e.code ?? ''
  if (code.startsWith('Key')) names.push(code.slice(3).toUpperCase())
  else if (code.startsWith('Digit')) names.push(code.slice(5))
  else if (code !== '') names.push(code.toUpperCase())
  if (e.key === ' ') names.push('SPACE')
  return names
}

export function matchesAccelerator(e: KeyPress, accel: string): boolean {
  const acc = parseAccelerator(accel)
  if (!acc) return false
  if (acc.metaOrCtrl) {
    if (!e.metaKey && !e.ctrlKey) return false
  } else {
    if (acc.meta !== e.metaKey) return false
    if (acc.ctrl !== e.ctrlKey) return false
  }
  if (acc.alt !== e.altKey) return false
  if (acc.shift !== e.shiftKey) return false
  return pressedKey(e).includes(acc.key)
}

const SYMBOLS: Record<string, string> = {
  meta: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  metaOrCtrl: '⌘'
}

/** Подпись для UI: `Alt+Command+I` → `⌥⌘I`. Не разобралось — показываем как есть. */
export function formatAccelerator(accel: string): string {
  const acc = parseAccelerator(accel)
  if (!acc) return accel
  const mods = (['ctrl', 'alt', 'shift', 'meta', 'metaOrCtrl'] as const)
    .filter((m) => acc[m])
    .map((m) => SYMBOLS[m])
    .join('')
  return `${mods}${acc.key}`
}
