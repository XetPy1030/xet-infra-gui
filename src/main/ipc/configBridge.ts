import { readFile, writeFile } from 'node:fs/promises'
import { app, dialog } from 'electron'
import type { ConfigSaveResult, ConfigService, ConfigState } from '@core/services/ConfigService'
import type { ConfigFileResult } from '@shared/types'

/**
 * Файловые операции с конфигом и перезапуск: всё, что требует Electron и потому
 * не может жить в ConfigService. Роутер знает только этот интерфейс.
 */
export interface ConfigBridge {
  state(): ConfigState
  save(text: string): ConfigSaveResult
  importFile(): Promise<ConfigFileResult>
  exportFile(): Promise<ConfigFileResult>
  relaunch(): void
}

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }]

export function createConfigBridge(config: ConfigService): ConfigBridge {
  return {
    state: () => config.state(),
    save: (text) => config.save(text),

    async importFile() {
      const picked = await dialog.showOpenDialog({
        title: 'Импорт конфига',
        filters: JSON_FILTER,
        properties: ['openFile']
      })
      const file = picked.filePaths[0]
      if (picked.canceled || !file) return { status: 'canceled', path: null, error: null }
      try {
        const saved = config.save(await readFile(file, 'utf8'))
        if (!saved.ok) return { status: 'error', path: file, error: saved.error }
        return { status: 'ok', path: file, error: null }
      } catch (e) {
        return { status: 'error', path: file, error: (e as Error).message }
      }
    },

    async exportFile() {
      const picked = await dialog.showSaveDialog({
        title: 'Экспорт конфига',
        defaultPath: 'xet-infra-gui-config.json',
        filters: JSON_FILTER
      })
      const file = picked.filePath
      if (picked.canceled || !file) return { status: 'canceled', path: null, error: null }
      try {
        await writeFile(file, config.state().text, 'utf8')
        return { status: 'ok', path: file, error: null }
      } catch (e) {
        return { status: 'error', path: file, error: (e as Error).message }
      }
    },

    relaunch() {
      app.relaunch()
      // quit, а не exit: before-quit гасит сессии и прокси штатно
      app.quit()
    }
  }
}
