import { describe, expect, it } from 'vitest'
import { locateJsonPath } from './jsonPath'

const CONFIG = `{
  "teleport": {
    "proxy": "teleport.example.com:443",
    "user": ""
  },
  "db": {
    "presets": [
      {
        "id": "db-dev",
        "port": 6432
      },
      {
        "id": "db-prod",
        "port": "нет"
      }
    ]
  }
}
`

describe('locateJsonPath', () => {
  it('находит строку вложенного ключа', () => {
    expect(locateJsonPath(CONFIG, 'teleport.user')).toBe(4)
  })

  it('находит элемент массива по индексу', () => {
    expect(locateJsonPath(CONFIG, 'db.presets.1.port')).toBe(14)
  })

  it('несуществующий путь падает на ближайшего предка', () => {
    expect(locateJsonPath(CONFIG, 'db.presets.1.nope.deeper')).toBe(12)
  })

  it('строка со скобками и экранированием не сбивает разбор', () => {
    const text = '{\n  "a": "}{\\" [1,2]",\n  "b": 1\n}'
    expect(locateJsonPath(text, 'b')).toBe(3)
  })

  it('пустой путь — начало файла, чужой корень — null', () => {
    expect(locateJsonPath(CONFIG, '')).toBe(1)
    expect(locateJsonPath('', 'a.b')).toBeNull()
  })
})
