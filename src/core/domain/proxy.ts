/**
 * Доменная модель DB-прокси (M1). Прокси — это *пресет* с жизненным циклом поверх
 * PTY-сессий: одна логическая «прокси dev» переживает несколько сессий (рестарты).
 *
 * FSM прокси (docs/03 §4.2 — «restarting» живёт здесь, а не в сессии: каждый
 * рестарт — это новый PTY, у сессии нет перехода назад в spawning):
 *
 *   off → starting → (awaiting_otp) → probing → healthy ⇄ degraded
 *   healthy/degraded --exit--> restarting → starting (backoff, лимит попыток)
 *   исчерпали попытки / порт занят чужим → error;  stop() из любого → off
 */
export type ProxyRunState =
  | 'off'
  | 'starting'
  | 'awaiting_otp'
  | 'probing'
  | 'healthy'
  | 'degraded'
  | 'restarting'
  | 'error'

/** Проекция прокси для UI/трея. Плоская — без ссылки на пресет (IPC-friendly). */
export interface ProxyView {
  presetId: string
  /** Подпись тумблера (dbName пресета: dev / stage / prod-replica / prod). */
  label: string
  env: string
  port: number
  dangerous: boolean
  state: ProxyRunState
  sessionId: string | null
  /** Номер попытки рестарта (0 — первый запуск после включения). */
  attempts: number
  /** Человекочитаемая причина состояния error. */
  error: string | null
}
