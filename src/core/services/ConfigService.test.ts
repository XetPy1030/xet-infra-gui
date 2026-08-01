import { describe, expect, it } from 'vitest'
import { noopLogger } from '../ports/Logger'
import type { ConfigStore } from '../ports/ConfigStore'
import { ConfigService } from './ConfigService'

class MemoryStore implements ConfigStore {
  readonly path = '/tmp/config.json'
  constructor(private text: string | null = null) {}
  read(): string | null {
    return this.text
  }
  write(text: string): void {
    this.text = text
  }
}

const make = (text: string | null): { service: ConfigService; store: MemoryStore } => {
  const store = new MemoryStore(text)
  return { service: new ConfigService(store, noopLogger), store }
}

const FILLED = JSON.stringify({
  teleport: { proxy: 'teleport.example.com:443', user: 'user@example.com' },
  kube: { namespace: 'apps' }
})

describe('ConfigService', () => {
  it('без файла создаёт пустой конфиг', () => {
    const { service, store } = make(null)
    expect(service.get().teleport.proxy).toBe('')
    expect(service.state().configured).toBe(false)
    // файл появился, чтобы его было видно и можно править руками
    expect(store.read()).toContain('"teleport"')
  })

  it('дополняет частичный конфиг дефолтами схемы', () => {
    const { service } = make(FILLED)
    const cfg = service.get()
    expect(cfg.teleport.user).toBe('user@example.com')
    expect(cfg.teleport.mfaMode).toBe('otp')
    expect(cfg.db.presets).toEqual([])
    expect(cfg.kube.logsTail).toBe(500)
    expect(service.state().configured).toBe(true)
  })

  it('битый файл не роняет старт: пустой конфиг + ошибка в состоянии', () => {
    const { service } = make('{ это не json')
    expect(service.get().teleport.proxy).toBe('')
    expect(service.state().error).toMatch(/JSON/)
  })

  it('невалидный по схеме файл сообщает путь до поля', () => {
    const { service } = make(JSON.stringify({ kube: { logsTail: -1 } }))
    expect(service.state().error).toContain('kube.logsTail')
  })

  it('save отклоняет невалидный текст и не трогает файл', () => {
    const { service, store } = make(FILLED)
    const res = service.save('{ "db": { "presets": [{ "id": "x" }] } }')
    expect(res.ok).toBe(false)
    expect(store.read()).toBe(FILLED)
  })

  it('save пишет канонический вид, но не подменяет конфиг запуска', () => {
    const { service, store } = make(FILLED)
    expect(service.save(JSON.stringify({ teleport: { proxy: 'other:443' } })).ok).toBe(true)
    expect(store.read()).toContain('"proxy": "other:443"')
    expect(service.get().teleport.proxy).toBe('teleport.example.com:443')
    expect(service.state().text).toContain('other:443')
  })
})
