import { contextBridge, ipcRenderer } from 'electron'
import { EVENT_CHANNELS, RPC_CHANNELS } from '../shared/channels'

// Узкий мост (ADR-0005): generic invoke/on со строгим allowlist каналов.
// Типизацию поверх даёт renderer (src/renderer/src/api.ts) из @shared/types.
const rpcChannels = new Set<string>(RPC_CHANNELS)
const eventChannels = new Set<string>(EVENT_CHANNELS)

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => {
    if (!rpcChannels.has(channel)) {
      return Promise.reject(new Error(`Неизвестный RPC-канал: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!eventChannels.has(channel)) {
      throw new Error(`Неизвестный канал событий: ${channel}`)
    }
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
})
