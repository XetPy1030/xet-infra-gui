import { describe, expect, it } from 'vitest'
import {
  OTP_PROMPT,
  PASSWORD_PROMPT
} from '../modules/teleport/__fixtures__/tsh'
import { TELEPORT_PROMPT_PATTERNS } from '../modules/teleport/prompts'
import type { PromptEvent } from './PromptPipeline'
import { PromptPipeline } from './PromptPipeline'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function makePipeline(creds: { password?: string | null; otp?: string | null }) {
  const written: string[] = []
  const events: PromptEvent[] = []
  const pipeline = new PromptPipeline(
    TELEPORT_PROMPT_PATTERNS,
    {
      resolve: async (kind) =>
        kind === 'password' ? (creds.password ?? null) : (creds.otp ?? null)
    },
    { write: (d) => written.push(d), onEvent: (e) => events.push(e) }
  )
  return { pipeline, written, events }
}

describe('PromptPipeline × промпты tsh (фикстуры)', () => {
  it('авто-отвечает на пароль и OTP', async () => {
    const { pipeline, written, events } = makePipeline({ password: 'p@ss', otp: '123456' })

    pipeline.feed(PASSWORD_PROMPT)
    await flush()
    expect(written).toEqual(['p@ss\r'])

    pipeline.feed('\r\n' + OTP_PROMPT)
    await flush()
    expect(written).toEqual(['p@ss\r', '123456\r'])

    expect(events).toEqual([
      { kind: 'password', phase: 'detected' },
      { kind: 'password', phase: 'answered' },
      { kind: 'otp', phase: 'detected' },
      { kind: 'otp', phase: 'answered' }
    ])
  })

  it('промпт, разрезанный по границе чанков, всё равно распознаётся', async () => {
    const { pipeline, written } = makePipeline({ otp: '654321' })
    const cut = OTP_PROMPT.length - 9
    pipeline.feed(OTP_PROMPT.slice(0, cut))
    await flush()
    expect(written).toEqual([])
    pipeline.feed(OTP_PROMPT.slice(cut))
    await flush()
    expect(written).toEqual(['654321\r'])
  })

  it('ANSI-обвязка и хвостовые пробелы не мешают матчу', async () => {
    const { pipeline, written } = makePipeline({ password: 'x' })
    pipeline.feed(`\u001b[1m${PASSWORD_PROMPT}\u001b[0m `)
    await flush()
    expect(written).toEqual(['x\r'])
  })

  it('нет креда → phase manual, ничего не пишет', async () => {
    const { pipeline, written, events } = makePipeline({ otp: null })
    pipeline.feed(OTP_PROMPT)
    await flush()
    expect(written).toEqual([])
    expect(events).toEqual([
      { kind: 'otp', phase: 'detected' },
      { kind: 'otp', phase: 'manual' }
    ])
  })

  it('повторный промпт того же вида (код отвергнут) → manual, без второго авто-ответа', async () => {
    const { pipeline, written, events } = makePipeline({ otp: '111111' })
    pipeline.feed(OTP_PROMPT)
    await flush()
    pipeline.feed('\r\nInvalid OTP code\r\n' + OTP_PROMPT)
    await flush()
    expect(written).toEqual(['111111\r'])
    expect(events.at(-1)).toEqual({ kind: 'otp', phase: 'manual' })
  })

  it('падение источника креда (throw) → manual, без исключения', async () => {
    const written: string[] = []
    const events: PromptEvent[] = []
    const pipeline = new PromptPipeline(
      TELEPORT_PROMPT_PATTERNS,
      {
        resolve: async () => {
          throw new Error('keychain locked')
        }
      },
      { write: (d) => written.push(d), onEvent: (e) => events.push(e) }
    )
    pipeline.feed(OTP_PROMPT)
    await flush()
    expect(written).toEqual([])
    expect(events).toEqual([
      { kind: 'otp', phase: 'detected' },
      { kind: 'otp', phase: 'manual' }
    ])
  })

  it('обычный вывод не триггерит ничего', async () => {
    const { pipeline, written, events } = makePipeline({ password: 'x', otp: 'y' })
    pipeline.feed('> Profile URL: https://teleport.example.com:443\r\n')
    pipeline.feed('  Logged in as: user@example.com\r\n')
    await flush()
    expect(written).toEqual([])
    expect(events).toEqual([])
  })
})
