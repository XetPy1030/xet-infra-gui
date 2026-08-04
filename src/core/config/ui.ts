import { z } from 'zod'

/**
 * Секция интерфейса (M4). В отличие от остальных секций она не принадлежит
 * модулю teleport: хоткеи — свойство самого приложения.
 *
 * Формат сочетаний — акселераторы Electron (`Alt+Command+I`), один и тот же для
 * глобального хоткея (его регистрирует main) и для внутренних (их ловит окно,
 * см. `shared/accelerator.ts`). Пустая строка — хоткей выключен.
 */
const hotkeysSchema = z.object({
  /** Глобальный: показать/скрыть окно из любого приложения (FR-U4). */
  toggleWindow: z.string().default('Alt+Command+I'),
  /** Палитра команд (docs/02 §4). */
  palette: z.string().default('CommandOrControl+K'),
  envDev: z.string().default('CommandOrControl+1'),
  envStage: z.string().default('CommandOrControl+2'),
  envProd: z.string().default('CommandOrControl+3')
})

export const uiSectionSchema = z.object({
  hotkeys: hotkeysSchema.prefault({})
})

type UiConfig = z.infer<typeof uiSectionSchema>
export type Hotkeys = UiConfig['hotkeys']
