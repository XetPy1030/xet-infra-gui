import type { EventMap, RpcMap } from '@shared/types'

type Req<K extends keyof RpcMap> = RpcMap[K]['req']

/** Типизированный RPC поверх generic-моста preload (ADR-0005). */
export function rpc<K extends keyof RpcMap>(
  channel: K,
  ...args: Req<K> extends void ? [] : [Req<K>]
): Promise<RpcMap[K]['res']> {
  return window.api.invoke(channel, args[0]) as Promise<RpcMap[K]['res']>
}

export function onEvent<K extends keyof EventMap>(
  channel: K,
  cb: (payload: EventMap[K]) => void
): () => void {
  return window.api.on(channel, cb as (payload: unknown) => void)
}
