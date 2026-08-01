import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ConfigStore } from '@core/ports/ConfigStore'

/**
 * `XET_CONFIG_PATH` — конфиг из произвольного файла: так dev-запуск смотрит в
 * личные артефакты (`local-artifacts/config.json`), не трогая userData.
 */
export function resolveConfigPath(userDataDir: string, env: NodeJS.ProcessEnv): string {
  const custom = env.XET_CONFIG_PATH?.trim()
  if (!custom) return join(userDataDir, 'config.json')
  return isAbsolute(custom) ? custom : resolve(custom)
}

export class FileConfigStore implements ConfigStore {
  constructor(readonly path: string) {}

  read(): string | null {
    if (!existsSync(this.path)) return null
    return readFileSync(this.path, 'utf8')
  }

  write(text: string): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, text, 'utf8')
  }
}
