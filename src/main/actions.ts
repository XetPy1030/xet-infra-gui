import { dialog } from 'electron'
import type { ActionRegistry } from '@core/services/ActionRegistry'
import type { Logger } from '@core/ports/Logger'
import { broadcast } from './ipc/router'

/**
 * Запуск действия вне окна — из трея или по хоткею (Command, ADR-0004). Вопросы
 * задаются нативными диалогами: окно в этот момент может быть закрыто, а
 * `window.confirm` renderer'а — недоступен. Политика (что спрашивать) живёт в
 * самом действии, здесь только показ.
 */
export type RunAction = (id: string, opts?: { param?: string }) => Promise<void>

/** Больше вопросов подряд у действия не бывает: prod + переключение порта. */
const MAX_CONFIRMS = 4

export function createActionRunner(
  registry: ActionRegistry,
  openWindow: () => void,
  logger: Logger
): RunAction {
  return async (id, opts) => {
    const confirmed: string[] = []
    for (let step = 0; step <= MAX_CONFIRMS; step += 1) {
      const res = await registry.run({ id, param: opts?.param, confirmed })
      if (res.ok) {
        if (res.reveal) {
          openWindow()
          broadcast('ui/reveal', { reveal: res.reveal })
        }
        return
      }
      if (res.reason !== 'needs-confirm') {
        logger.warn(`Действие «${id}»: ${res.error}`)
        dialog.showErrorBox('Не получилось', res.error)
        return
      }
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: res.error,
        buttons: ['Продолжить', 'Отмена'],
        defaultId: 1,
        cancelId: 1
      })
      if (response !== 0) return
      confirmed.push(res.confirmKey)
    }
    logger.warn(`Действие «${id}» просит подтверждения по кругу — прекращаю`)
  }
}
