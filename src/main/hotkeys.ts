import { globalShortcut } from 'electron'
import type { Hotkeys } from '@core/config/ui'
import type { Logger } from '@core/ports/Logger'

/**
 * Глобальный хоткей окна (FR-U4). Остальные сочетания ловит окно —
 * `globalShortcut` перехватывает их у всей системы, и делать это ради ⌘K,
 * который нужен только в приложении, нельзя.
 */
export interface GlobalHotkeys {
  /** Не удалось зарегистрировать (занято другим приложением/опечатка) — в UI. */
  error: string | null
  dispose(): void
}

export function registerGlobalHotkeys(
  hotkeys: Hotkeys,
  toggleWindow: () => void,
  logger: Logger
): GlobalHotkeys {
  const accel = hotkeys.toggleWindow.trim()
  if (accel === '') return { error: null, dispose: () => undefined }

  let error: string | null = null
  try {
    // false — сочетание занято другим приложением; исключение — оно не разобралось
    if (!globalShortcut.register(accel, toggleWindow)) {
      error = `Глобальный хоткей «${accel}» занят другим приложением`
    }
  } catch (e) {
    error = `Глобальный хоткей «${accel}» не разобрался: ${(e as Error).message}`
  }
  if (error) logger.warn(error)
  else logger.info(`Глобальный хоткей: ${accel}`)

  return {
    error,
    dispose: () => globalShortcut.unregisterAll()
  }
}
