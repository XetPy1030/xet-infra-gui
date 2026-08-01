export type Listener<T> = (payload: T) => void

/** Минимальный типизированный emitter (Observer): core → main → IPC push. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, cb: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb as Listener<never>)
    return () => set.delete(cb as Listener<never>)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const cb of [...set]) (cb as Listener<Events[K]>)(payload)
  }
}
