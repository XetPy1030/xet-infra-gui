import { connect } from 'node:net'
import type { TcpProbe } from '@core/ports/TcpProbe'

/** Адаптер TcpProbe: node:net connect+close, никогда не reject'ится. */
export class NetTcpProbe implements TcpProbe {
  check(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ host, port })
      let settled = false
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        sock.destroy()
        resolve(ok)
      }
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
    })
  }
}
