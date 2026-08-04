import { formatAccelerator } from '@shared/accelerator'
import type { Hotkeys } from '@shared/types'
import { rpc } from '../api'
import { useApp } from '../store'
import { ConfigPanel } from './ConfigPanel'
import { CredsForm } from './CredsForm'

/** Подписи хоткеев конфига: что именно переназначает пользователь (docs/02 §5). */
const HOTKEY_LABELS: Record<keyof Hotkeys, string> = {
  toggleWindow: 'Показать/скрыть окно (глобальный)',
  palette: 'Палитра команд',
  envDev: 'Окружение dev',
  envStage: 'Окружение stage',
  envProd: 'Окружение prod'
}

export function SettingsPanel(): React.JSX.Element {
  const { ui, setUi, setWizardOpen } = useApp()

  const setAutostart = async (enabled: boolean): Promise<void> => {
    const res = await rpc('app.setAutostart', { enabled })
    if (ui) setUi({ ...ui, autostart: res.enabled })
  }

  return (
    <div className="settings">
      <div className="settings-row">
        <span className="settings-label">Первый запуск</span>
        <button className="primary" onClick={() => setWizardOpen(true)}>
          Мастер настройки
        </button>
        <span className="settings-note">
          Проверит tsh, соберёт конфиг, положит креды в Keychain и сделает тестовый логин.
        </span>
      </div>

      <h3 className="settings-title">Конфиг</h3>
      <ConfigPanel />

      <h3 className="settings-title">Креды</h3>
      <CredsForm />

      <h3 className="settings-title">Приложение</h3>
      <div className="settings-row">
        <span className="settings-label">Автозапуск при входе</span>
        <button
          className={`toggle ${ui?.autostart ? 'toggle-on' : ''}`}
          title="Запускать приложение при входе в систему"
          onClick={() => void setAutostart(!ui?.autostart)}
        >
          <span className="knob" />
        </button>
        <span className="settings-note">{ui?.autostart ? 'включён' : 'выключен'}</span>
      </div>

      <div className="settings-row">
        <span className="settings-label">Хоткеи</span>
        <span className="settings-note">
          Переназначаются в конфиге, секция <b>ui.hotkeys</b> (формат Electron: `Alt+Command+I`,
          пусто — выключить). Применяются перезапуском.
        </span>
      </div>
      {ui &&
        (Object.keys(HOTKEY_LABELS) as (keyof Hotkeys)[]).map((key) => (
          <div className="settings-row settings-hotkey" key={key}>
            <span className="settings-label">{HOTKEY_LABELS[key]}</span>
            <kbd>{ui.hotkeys[key].trim() === '' ? 'выключен' : formatAccelerator(ui.hotkeys[key])}</kbd>
          </div>
        ))}
      {ui?.hotkeyError && <div className="banner banner-red">{ui.hotkeyError}</div>}
    </div>
  )
}
