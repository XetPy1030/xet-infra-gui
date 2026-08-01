/**
 * Порт TCP-доступности: readiness/health прокси-туннелей (docs/04 §3.2 —
 * stdout tsh не парсим, критерий готовности — успешный connect на localhost:port).
 */
export interface TcpProbe {
  /** true — порт принял соединение за timeoutMs (сокет сразу закрывается). */
  check(host: string, port: number, timeoutMs: number): Promise<boolean>
}
