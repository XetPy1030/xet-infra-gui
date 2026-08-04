import type { Logger } from '../ports/Logger'

/**
 * Реестр действий (Command, ADR-0004): одно определение действия питает палитру
 * ⌘K, меню трея и хоткеи. Действия исполняются в main — там живут сервисы,
 * — а renderer получает каталог по IPC и запускает по id.
 *
 * Каталог динамический: он зависит от конфига (пресеты, workload'ы) и текущего
 * окружения, поэтому провайдеры вызываются на каждый `list()`.
 */

/** Куда смотреть после успеха — подсказка окну, а не команда (docs/02 §4). */
export interface ActionReveal {
  view?: 'pods' | 'sql' | 'session' | 'settings'
  /** Открыть таб этой сессии. */
  sessionId?: string
  /** Выбрать этот db-пресет в SQL-консоли. */
  presetId?: string
}

/** Каталожная часть действия: то, что едет в UI (без `run`). */
export interface ActionDescriptor {
  id: string
  /** Готовая подпись: «Bash → api (dev)» — пользователь не видит команд CLI. */
  title: string
  /** Секция в палитре: «Teleport», «DB-прокси», «Kubernetes», «SQL», «Окно». */
  group: string
  /** Слова для поиска, которых нет в подписи (латиница к русской подписи и наоборот). */
  keywords?: string
  /** Боевое окружение: в палитре красным (US-14). */
  dangerous?: boolean
  /** Действию нужен свободный текст — палитра спросит вторым шагом. */
  param?: { label: string; placeholder?: string }
}

export type ActionResult =
  | { ok: true; reveal?: ActionReveal }
  /**
   * Нужен ответ пользователя. Ключ — чтобы вопросов могло быть несколько подряд
   * (prod, потом переключение общего порта) и «да» на один не считалось «да» на
   * все: вызывающий спрашивает и повторяет запуск с накопленными ключами.
   */
  | { ok: false; reason: 'needs-confirm'; confirmKey: string; error: string }
  | {
      ok: false
      reason: 'unknown-action' | 'needs-param' | 'failed'
      error: string
      /** Ошибка пахнет протухшей сессией — UI предложит перелогин. */
      needsLogin?: boolean
    }

export interface ActionContext {
  /** Текст из палитры; '' — действие без параметра. */
  param: string
  /** Пользователь уже ответил «да» на вопрос с этим ключом. */
  confirmed(key: string): boolean
}

export interface Action extends ActionDescriptor {
  run(ctx: ActionContext): Promise<ActionResult> | ActionResult
}

/** Провайдер действий модуля (ADR-0006): вызывается на каждый показ каталога. */
export type ActionProvider = () => Action[]

/** Сахар: «спроси вот это и позови меня снова». */
export function askConfirm(confirmKey: string, question: string): ActionResult {
  return { ok: false, reason: 'needs-confirm', confirmKey, error: question }
}

export interface ActionRunReq {
  id: string
  param?: string
  /** Ключи вопросов, на которые пользователь уже ответил «да». */
  confirmed?: string[]
}

export class ActionRegistry {
  constructor(
    private readonly providers: ActionProvider[],
    private readonly logger: Logger
  ) {}

  /** Каталог для палитры и трея: без `run` — исполнять действия можно только здесь. */
  list(): ActionDescriptor[] {
    return this.actions().map((a) => ({
      id: a.id,
      title: a.title,
      group: a.group,
      ...(a.keywords === undefined ? {} : { keywords: a.keywords }),
      ...(a.dangerous === undefined ? {} : { dangerous: a.dangerous }),
      ...(a.param === undefined ? {} : { param: a.param })
    }))
  }

  async run(req: ActionRunReq): Promise<ActionResult> {
    const action = this.actions().find((a) => a.id === req.id)
    if (!action) {
      return { ok: false, reason: 'unknown-action', error: `Действие «${req.id}» не найдено` }
    }
    const param = req.param?.trim() ?? ''
    if (action.param && param === '') {
      return { ok: false, reason: 'needs-param', error: action.param.label }
    }
    const confirmed = new Set(req.confirmed ?? [])
    try {
      return await action.run({ param, confirmed: (key) => confirmed.has(key) })
    } catch (e) {
      // действие ходит в CLI и в сеть: исключение здесь — обычный отказ, а не баг
      this.logger.warn(`Действие «${action.id}» упало`, e)
      return { ok: false, reason: 'failed', error: (e as Error).message }
    }
  }

  private actions(): Action[] {
    const seen = new Set<string>()
    const all: Action[] = []
    for (const provider of this.providers) {
      for (const action of provider()) {
        if (seen.has(action.id)) {
          this.logger.warn(`Действие «${action.id}» объявлено дважды — беру первое`)
          continue
        }
        seen.add(action.id)
        all.push(action)
      }
    }
    return all
  }
}
