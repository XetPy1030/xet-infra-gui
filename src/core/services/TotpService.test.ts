import { describe, expect, it } from 'vitest'
import { TotpService } from './TotpService'

// RFC 6238, Appendix B: secret ASCII "12345678901234567890" (base32 ниже),
// T = 59s → 8-значный код 94287082 → 6-значный хвост 287082.
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

const store = (secret: string | null) => ({
  getPassword: async () => null,
  getTotpSecret: async () => secret
})

describe('TotpService', () => {
  it('генерирует код по RFC 6238 вектору (fixed clock)', async () => {
    const svc = new TotpService(store(RFC_SECRET_B32), { now: () => 59_000 })
    expect(await svc.generate()).toBe('287082')
  })

  it('нормализует секрет (пробелы, нижний регистр)', async () => {
    const messy = ' gezd gnbv gy3t qojq gezd gnbv gy3t qojq '
    const svc = new TotpService(store(messy), { now: () => 59_000 })
    expect(await svc.generate()).toBe('287082')
  })

  it('нет секрета → null (ручной фолбэк)', async () => {
    const svc = new TotpService(store(null), { now: () => 59_000 })
    expect(await svc.generate()).toBeNull()
  })

  it('кривой секрет → null, а не исключение', async () => {
    const svc = new TotpService(store('!!не base32!!'), { now: () => 59_000 })
    expect(await svc.generate()).toBeNull()
  })
})
