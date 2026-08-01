import { execFile } from 'node:child_process'
import type { ProcessRunner, RunOptions, RunResult } from '@core/ports/ProcessRunner'

/** Адаптер ProcessRunner: execFile с таймаутом; никогда не reject'ится. */
export class ExecFileRunner implements ProcessRunner {
  constructor(private readonly baseEnv: Record<string, string | undefined>) {}

  run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          timeout: opts.timeoutMs ?? 15_000,
          maxBuffer: 16 * 1024 * 1024,
          cwd: opts.cwd,
          env: { ...this.baseEnv, ...opts.env } as NodeJS.ProcessEnv
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ stdout, stderr, code: 0 })
            return
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean }
          const code = typeof e.code === 'number' ? e.code : null
          resolve({
            stdout: stdout ?? '',
            stderr: (stderr ?? '') || e.message,
            code
          })
        }
      )
    })
  }
}
