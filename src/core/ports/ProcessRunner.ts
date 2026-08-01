export interface RunResult {
  stdout: string
  stderr: string
  /** exit-код процесса; null — процесс не запустился или убит по таймауту */
  code: number | null
}

export interface RunOptions {
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string | undefined>
}

/**
 * Порт неинтерактивного запуска процессов (структурированные запросы: status, get pods…).
 * Никогда не reject'ится: любые ошибки спавна/таймаута → { code: null, stderr }.
 */
export interface ProcessRunner {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>
}
