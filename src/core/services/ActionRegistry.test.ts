import { describe, expect, it, vi } from 'vitest'
import { noopLogger as logger } from '../ports/Logger'
import { ActionRegistry, askConfirm, type Action, type ActionContext } from './ActionRegistry'

const action = (over: Partial<Action> & { id: string }): Action => ({
  title: over.id,
  group: 'Тест',
  run: () => ({ ok: true }),
  ...over
})

describe('ActionRegistry', () => {
  it('каталог собирается из провайдеров и не содержит run', () => {
    const registry = new ActionRegistry(
      [() => [action({ id: 'a' })], () => [action({ id: 'b', dangerous: true })]],
      logger
    )
    const list = registry.list()
    expect(list.map((a) => a.id)).toEqual(['a', 'b'])
    expect(list[1]).toEqual({ id: 'b', title: 'b', group: 'Тест', dangerous: true })
    expect('run' in (list[0] as object)).toBe(false)
  })

  it('каталог пересобирается на каждый показ: подписи зависят от состояния', () => {
    let on = false
    const registry = new ActionRegistry(
      [() => [action({ id: 'p', title: on ? 'выключить' : 'включить' })]],
      logger
    )
    expect(registry.list()[0]?.title).toBe('включить')
    on = true
    expect(registry.list()[0]?.title).toBe('выключить')
  })

  it('дубликат id не подменяет первое действие', () => {
    const registry = new ActionRegistry(
      [() => [action({ id: 'a', title: 'первое' })], () => [action({ id: 'a', title: 'второе' })]],
      logger
    )
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.title).toBe('первое')
  })

  it('неизвестное действие — отказ, а не исключение', async () => {
    const registry = new ActionRegistry([], logger)
    await expect(registry.run({ id: 'нет' })).resolves.toMatchObject({
      ok: false,
      reason: 'unknown-action'
    })
  })

  it('действие с параметром не запускается без него', async () => {
    const run = vi.fn(() => ({ ok: true }) as const)
    const registry = new ActionRegistry(
      [() => [action({ id: 'exec', param: { label: 'Команда' }, run })]],
      logger
    )
    await expect(registry.run({ id: 'exec', param: '   ' })).resolves.toMatchObject({
      ok: false,
      reason: 'needs-param',
      error: 'Команда'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('параметр приходит обрезанным', async () => {
    let seen: string | null = null
    const run = (ctx: ActionContext): ReturnType<Action['run']> => {
      seen = ctx.param
      return { ok: true }
    }
    const registry = new ActionRegistry(
      [() => [action({ id: 'exec', param: { label: 'Команда' }, run })]],
      logger
    )
    await registry.run({ id: 'exec', param: '  ls -la  ' })
    expect(seen).toBe('ls -la')
  })

  it('подтверждения независимы: «да» на один вопрос не отвечает за другой', async () => {
    const started: string[] = []
    const registry = new ActionRegistry(
      [
        () => [
          action({
            id: 'proxy',
            run: (ctx) => {
              if (!ctx.confirmed('prod')) return askConfirm('prod', 'Боевая база?')
              if (!ctx.confirmed('conflict')) return askConfirm('conflict', 'Переключить порт?')
              started.push('go')
              return { ok: true }
            }
          })
        ]
      ],
      logger
    )

    const first = await registry.run({ id: 'proxy' })
    expect(first).toMatchObject({ reason: 'needs-confirm', confirmKey: 'prod' })
    const second = await registry.run({ id: 'proxy', confirmed: ['prod'] })
    expect(second).toMatchObject({ reason: 'needs-confirm', confirmKey: 'conflict' })
    const third = await registry.run({ id: 'proxy', confirmed: ['prod', 'conflict'] })
    expect(third).toEqual({ ok: true })
    expect(started).toEqual(['go'])
  })

  it('исключение внутри действия — отказ с текстом, приложение живёт', async () => {
    const registry = new ActionRegistry(
      [
        () => [
          action({
            id: 'boom',
            run: () => {
              throw new Error('tsh не найден')
            }
          })
        ]
      ],
      logger
    )
    await expect(registry.run({ id: 'boom' })).resolves.toEqual({
      ok: false,
      reason: 'failed',
      error: 'tsh не найден'
    })
  })
})
