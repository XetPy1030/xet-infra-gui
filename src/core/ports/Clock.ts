export interface Clock {
  /** Текущее время, миллисекунды Unix. */
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }
