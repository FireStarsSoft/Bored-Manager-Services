import { vi } from 'vitest'

/** Run one test action with deterministic Date/timer APIs and always restore them. */
export async function withFakeClock<T>(
  now: string | number | Date,
  run: () => T | Promise<T>
): Promise<T> {
  vi.useFakeTimers({ now: typeof now === 'string' ? new Date(now) : now })
  try {
    return await run()
  } finally {
    vi.useRealTimers()
  }
}
