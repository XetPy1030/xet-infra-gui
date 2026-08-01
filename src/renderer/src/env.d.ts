/// <reference types="vite/client" />

// Поверхность preload-моста; типизация каналов — в api.ts через @shared/types.
interface Window {
  api: {
    invoke(channel: string, payload?: unknown): Promise<unknown>
    on(channel: string, cb: (payload: unknown) => void): () => void
  }
}
