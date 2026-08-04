/**
 * Где в тексте JSON лежит значение по пути вида `db.presets.0.port`. Нужно
 * редактору конфига: zod сообщает путь проблемы, а показать её надо строкой
 * (FR-C1). Разбор свой, а не через JSON.parse, потому что позиции в тексте
 * стандартный парсер не отдаёт.
 *
 * Живёт в shared: пути приезжают из main, а прыгает по строкам renderer.
 */

/** Путь → смещение начала значения в тексте. Невалидный JSON — что успели. */
function indexJson(text: string): Map<string, number> {
  const offsets = new Map<string, number>()
  let i = 0

  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i] as string)) i += 1
  }

  const readString = (): string => {
    // вызывается на открывающей кавычке
    let out = ''
    i += 1
    while (i < text.length) {
      const ch = text[i] as string
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') {
        i += 1
        return out
      }
      out += ch
      i += 1
    }
    return out
  }

  const readValue = (path: string): void => {
    skipWs()
    if (i >= text.length) return
    offsets.set(path, i)
    const ch = text[i] as string
    if (ch === '{') {
      i += 1
      for (;;) {
        skipWs()
        if (i >= text.length) return
        if (text[i] === '}') {
          i += 1
          return
        }
        if (text[i] !== '"') return // мусор вместо ключа — дальше не гадаем
        const key = readString()
        skipWs()
        if (text[i] !== ':') return
        i += 1
        readValue(path === '' ? key : `${path}.${key}`)
        skipWs()
        if (text[i] === ',') i += 1
      }
    }
    if (ch === '[') {
      i += 1
      let index = 0
      for (;;) {
        skipWs()
        if (i >= text.length) return
        if (text[i] === ']') {
          i += 1
          return
        }
        readValue(path === '' ? String(index) : `${path}.${index}`)
        index += 1
        skipWs()
        if (text[i] === ',') i += 1
      }
    }
    if (ch === '"') {
      readString()
      return
    }
    // число, true/false/null — до ближайшего разделителя
    while (i < text.length && !/[,}\]\s]/.test(text[i] as string)) i += 1
  }

  readValue('')
  return offsets
}

/** Строка (1-based) значения по пути; нет такого — ближайший существующий предок. */
export function locateJsonPath(text: string, path: string): number | null {
  const offsets = indexJson(text)
  let probe = path
  for (;;) {
    const offset = offsets.get(probe)
    if (offset !== undefined) {
      let line = 1
      for (let k = 0; k < offset; k += 1) if (text[k] === '\n') line += 1
      return line
    }
    if (probe === '') return null
    const cut = probe.lastIndexOf('.')
    probe = cut === -1 ? '' : probe.slice(0, cut)
  }
}
