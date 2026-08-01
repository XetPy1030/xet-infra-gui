import {
  EMPTY_CONFIG,
  formatConfig,
  isConfigured,
  parseConfigText,
  type AppConfig
} from '../config/schema'
import type { ConfigStore } from '../ports/ConfigStore'
import type { Logger } from '../ports/Logger'

/** Снимок для UI: сам конфиг секретов не содержит, поэтому ходит текстом. */
export interface ConfigState {
  path: string
  /** false — не заданы proxy/user, приложению нечего делать до настройки. */
  configured: boolean
  /** Содержимое файла: то, что редактируется и экспортируется. */
  text: string
  /** Ошибка разбора файла на старте — работаем на пустом конфиге, но честно об этом говорим. */
  error: string | null
}

export type ConfigSaveResult = { ok: true } | { ok: false; error: string }

/**
 * Конфиг приложения: читает при старте, валидирует схемой, сохраняет правки.
 *
 * Сохранение НЕ подменяет конфиг на лету: половина сервисов получает секции
 * при сборке composition root, и частичный горячий подхват дал бы состояние
 * «часть приложения на новом конфиге, часть на старом». Поэтому `get()` до
 * конца процесса отдаёт стартовый конфиг, а UI после записи предлагает
 * перезапуск.
 */
export class ConfigService {
  private readonly config: AppConfig
  private readonly loadError: string | null

  constructor(
    private readonly store: ConfigStore,
    private readonly logger: Logger
  ) {
    const text = store.read()
    if (text === null) {
      this.config = EMPTY_CONFIG
      this.loadError = null
      this.writeFile(EMPTY_CONFIG)
      logger.info(`Конфига не было, создан пустой: ${store.path}`)
      return
    }
    const parsed = parseConfigText(text)
    if (parsed.ok) {
      this.config = parsed.config
      this.loadError = null
      return
    }
    this.config = EMPTY_CONFIG
    this.loadError = parsed.error
    logger.warn(`Конфиг невалиден (${store.path}), работаю на пустом:\n${parsed.error}`)
  }

  /** Конфиг, с которым стартовало приложение. */
  get(): AppConfig {
    return this.config
  }

  state(): ConfigState {
    const text = this.store.read()
    return {
      path: this.store.path,
      configured: isConfigured(this.config),
      text: text ?? formatConfig(EMPTY_CONFIG),
      error: this.loadError
    }
  }

  /** Правка из редактора или импорт шаблона: валидируем, пишем канонический вид. */
  save(text: string): ConfigSaveResult {
    const parsed = parseConfigText(text)
    if (!parsed.ok) return parsed
    try {
      this.writeFile(parsed.config)
    } catch (e) {
      return { ok: false, error: `не удалось записать ${this.store.path}: ${(e as Error).message}` }
    }
    this.logger.info(`Конфиг сохранён: ${this.store.path}`)
    return { ok: true }
  }

  private writeFile(config: AppConfig): void {
    this.store.write(formatConfig(config))
  }
}
