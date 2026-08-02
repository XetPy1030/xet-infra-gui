import type { TextStore } from './TextStore'

/**
 * Хранилище конфига (ADR-0004): тот же текстовый порт, что и у истории
 * запросов — форма одна, различаются только путь и владелец разбора.
 */
export type ConfigStore = TextStore
