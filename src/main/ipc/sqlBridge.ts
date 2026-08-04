import { dialog } from 'electron'
import type { DumpService, DumpStartResult } from '@core/services/DumpService'

/**
 * Дампы со стороны Electron: выбор файла назначения. Сам запуск и прогресс —
 * в DumpService, уведомление о финале — в notifications.ts (там же, где и про
 * остальные фоновые задачи); здесь только то, чему нужен Electron.
 */
export interface SqlBridge {
  dump(req: {
    dumpId: string
    presetId: string
  }): Promise<DumpStartResult | { ok: false; reason: 'canceled'; error: null }>
}

export function createSqlBridge(dumps: DumpService): SqlBridge {
  return {
    async dump({ dumpId, presetId }) {
      const suggested = dumps.defaultFile(dumpId, presetId)
      if (suggested === null) {
        return { ok: false, reason: 'unknown-preset', error: 'Пресет дампа или базы не найден' }
      }
      const picked = await dialog.showSaveDialog({
        title: 'Куда сохранить дамп',
        defaultPath: suggested,
        properties: ['createDirectory', 'showOverwriteConfirmation']
      })
      if (picked.canceled || !picked.filePath) {
        return { ok: false, reason: 'canceled', error: null }
      }
      return dumps.start({ dumpId, presetId, file: picked.filePath })
    }
  }
}
