import type { SessionSpec } from '../domain/session'

export interface PtyHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number | null }) => void): void
  /** Backpressure (docs/03 §6): перестать читать вывод процесса. */
  pause(): void
  resume(): void
}

/** Порт создания PTY. Реализация в main — node-pty (main/adapters/NodePtyFactory). */
export interface PtyFactory {
  spawn(spec: SessionSpec): PtyHandle
}
