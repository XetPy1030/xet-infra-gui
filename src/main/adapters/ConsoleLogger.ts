import type { Logger } from '@core/ports/Logger'

const ts = (): string => new Date().toISOString().slice(11, 23)

export class ConsoleLogger implements Logger {
  debug(msg: string, meta?: unknown): void {
    console.debug(`[${ts()}] ${msg}`, meta ?? '')
  }
  info(msg: string, meta?: unknown): void {
    console.info(`[${ts()}] ${msg}`, meta ?? '')
  }
  warn(msg: string, meta?: unknown): void {
    console.warn(`[${ts()}] ${msg}`, meta ?? '')
  }
  error(msg: string, meta?: unknown): void {
    console.error(`[${ts()}] ${msg}`, meta ?? '')
  }
}
