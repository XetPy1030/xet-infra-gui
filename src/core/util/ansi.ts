// Вырезание ANSI-последовательностей (CSI / OSC / charset / keypad) — только для
// матчинга промптов в PromptPipeline, рендером занимается xterm.
const ANSI_RE = new RegExp(
  [
    '\\u001b\\[[0-9;?]*[0-9A-Za-z]', // CSI: цвета, курсор, очистка
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?', // OSC: заголовок окна и т.п.
    '\\u001b[()][0-9A-Za-z]', // выбор charset
    '\\u001b[=>]' // keypad-режимы
  ].join('|'),
  'g'
)

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')
