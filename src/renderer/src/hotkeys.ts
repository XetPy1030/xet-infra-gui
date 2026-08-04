import { useEffect } from 'react'
import { matchesAccelerator } from '@shared/accelerator'
import type { Hotkeys } from '@shared/types'
import { runAction } from './actions'
import { useApp } from './store'

/** Хоткей → что делать. Глобальный (`toggleWindow`) живёт в main, не здесь. */
const BINDINGS: { key: keyof Hotkeys; run: () => void }[] = [
  {
    key: 'palette',
    run: () => {
      const s = useApp.getState()
      s.setPaletteOpen(!s.paletteOpen)
    }
  },
  { key: 'envDev', run: () => void runAction('kube.env:dev') },
  { key: 'envStage', run: () => void runAction('kube.env:stage') },
  { key: 'envProd', run: () => void runAction('kube.env:prod') }
]

/**
 * Внутренние хоткеи окна (docs/02 §5, FR-U4). Слушаем на фазе перехвата:
 * фокус обычно в xterm, а он забирает нажатия себе — до всплытия ⌘K не доживёт.
 */
export function useHotkeys(): void {
  const hotkeys = useApp((s) => s.ui?.hotkeys ?? null)

  useEffect(() => {
    if (!hotkeys) return
    const onKeyDown = (e: KeyboardEvent): void => {
      for (const { key, run } of BINDINGS) {
        const accel = hotkeys[key]
        if (accel.trim() !== '' && matchesAccelerator(e, accel)) {
          e.preventDefault()
          e.stopPropagation()
          run()
          return
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [hotkeys])
}
