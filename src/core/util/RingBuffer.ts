/**
 * Кольцевой буфер сырого вывода сессии (FR-S3): replay в свежий xterm при
 * переоткрытии окна. Хранит хвост до cap символов.
 */
export class RingBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly cap = 256 * 1024) {}

  push(chunk: string): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.cap && this.chunks.length > 1) {
      const removed = this.chunks.shift()
      this.size -= removed?.length ?? 0
    }
    // единственный чанк больше cap — режем его
    if (this.size > this.cap && this.chunks.length === 1) {
      const only = this.chunks[0] ?? ''
      this.chunks[0] = only.slice(-this.cap)
      this.size = this.chunks[0].length
    }
  }

  toString(): string {
    return this.chunks.join('')
  }
}
