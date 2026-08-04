import { BrowserWindow, Notification, shell } from 'electron'
import type { AuthService } from '@core/services/AuthService'
import type { DumpService } from '@core/services/DumpService'
import type { ProxySupervisor } from '@core/services/ProxySupervisor'
import { formatBytes } from '@shared/bytes'

/**
 * Системные уведомления о фоновом (docs/02 §7). Приложение menu-bar: окно
 * закрыто большую часть жизни, и «дамп готов» или «прокси упала» иначе
 * пропадут впустую.
 *
 * Общее правило — уведомляем, только когда окно не в фокусе: если пользователь
 * смотрит в приложение, он и так всё видит, а лишний баннер macOS раздражает.
 */
export interface NotificationDeps {
  dumps: DumpService
  supervisor: ProxySupervisor
  auth: AuthService
  openWindow: () => void
}

export function createNotifications({
  dumps,
  supervisor,
  auth,
  openWindow
}: NotificationDeps): void {
  const focused = (): boolean => BrowserWindow.getAllWindows().some((w) => w.isFocused())

  const notify = (title: string, body: string, onClick?: () => void): void => {
    if (!Notification.isSupported() || focused()) return
    const note = new Notification({ title, body })
    note.on('click', onClick ?? openWindow)
    note.show()
  }

  dumps.events.on('finished', ({ task }) => {
    const ok = task.state === 'done'
    notify(
      ok ? `${task.title}: готово` : `${task.title}: не удалось`,
      ok ?
        `${task.label} → ${task.file} (${formatBytes(task.bytes)})`
      : (task.error ?? 'Команда дампа завершилась с ошибкой'),
      // клик по готовому дампу — показать файл в Finder: обычно за этим и следят
      ok ? () => shell.showItemInFolder(task.file) : undefined
    )
  })

  // событие приходит только на смене состояния, так что это именно переход в error
  supervisor.events.on('state', ({ view }) => {
    if (view.state !== 'error') return
    notify(`DB-прокси ${view.label}: ошибка`, view.error ?? 'Туннель остановлен')
  })

  auth.events.on('loggedIn', ({ status }) => {
    notify('Teleport: вход выполнен', `${status.username ?? ''} · ${status.cluster ?? ''}`.trim())
  })
}
