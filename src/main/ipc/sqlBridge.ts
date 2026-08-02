import { dialog, Notification, shell } from 'electron'
import type { DumpService, DumpStartResult } from '@core/services/DumpService'
import { formatBytes } from '@shared/bytes'

/**
 * Дампы со стороны Electron: выбор файла и системное уведомление о финале.
 * Сам запуск и прогресс — в DumpService; здесь только то, чему нужен Electron
 * (тот же приём, что у configBridge).
 */
export interface SqlBridge {
  dump(req: {
    dumpId: string
    presetId: string
  }): Promise<DumpStartResult | { ok: false; reason: 'canceled'; error: null }>
}

export function createSqlBridge(dumps: DumpService): SqlBridge {
  // окно у menu-bar-приложения обычно скрыто — о конце длинной задачи говорим
  // системным уведомлением (docs/02 §7)
  dumps.events.on('finished', ({ task }) => {
    if (!Notification.isSupported()) return
    const ok = task.state === 'done'
    const note = new Notification({
      title: ok ? `${task.title}: готово` : `${task.title}: не удалось`,
      body:
        ok ?
          `${task.label} → ${task.file} (${formatBytes(task.bytes)})`
        : (task.error ?? 'Команда дампа завершилась с ошибкой')
    })
    // клик по уведомлению — показать файл в Finder: обычно за этим и следят
    if (ok) note.on('click', () => shell.showItemInFolder(task.file))
    note.show()
  })

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
