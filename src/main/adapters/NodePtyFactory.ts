import os from 'node:os'
import pty from 'node-pty'
import type { SessionSpec } from '@core/domain/session'
import type { PtyFactory, PtyHandle } from '@core/ports/PtyFactory'

const cleanEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >

/** Адаптер порта PtyFactory поверх node-pty (N-API prebuild, ADR-0002). */
export class NodePtyFactory implements PtyFactory {
  constructor(private readonly baseEnv: Record<string, string | undefined>) {}

  spawn(spec: SessionSpec): PtyHandle {
    const proc = pty.spawn(spec.cmd, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 32,
      cwd: spec.cwd ?? os.homedir(),
      env: cleanEnv({ ...this.baseEnv, ...spec.env, TERM: 'xterm-256color' })
    })
    return {
      write: (data) => proc.write(data),
      resize: (cols, rows) => {
        try {
          proc.resize(cols, rows)
        } catch {
          /* умерший pty — не наша проблема */
        }
      },
      kill: (signal) => {
        try {
          proc.kill(signal)
        } catch {
          /* уже мёртв */
        }
      },
      onData: (cb) => {
        proc.onData(cb)
      },
      onExit: (cb) => {
        proc.onExit(({ exitCode }) => cb({ exitCode: exitCode ?? null }))
      },
      pause: () => {
        try {
          proc.pause()
        } catch {
          /* мёртвый pty */
        }
      },
      resume: () => {
        try {
          proc.resume()
        } catch {
          /* мёртвый pty */
        }
      }
    }
  }
}
