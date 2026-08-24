import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FleetJobs } from '../../service-fleet/main/jobs'
import { HostStore } from '../../service-fleet/main/store'
import { moduleHarness } from '../helpers/module-harness'

/**
 * A module's fire-and-forget work - a fleet job, a manual slow refresh - can
 * still be waiting on the target when the user disables the module, reloads
 * it, or the machine disconnects. The host revokes the context at that point,
 * and until this was guarded the late `emit`/`log`/host-data write threw from
 * a promise nobody was holding, which the server treated as fatal: one browser
 * tab disabling a module took every machine, terminal and user down with it.
 *
 * The scaffolding below is copied rather than shared: this started as one
 * suite in the app repository covering several modules at once, and each
 * module that moved to its own repository took its own cases with it. Copying
 * ~40 lines is what lets the *reason* travel with the test.
 */

/** Any rejection or throw that escapes to the process is what we are testing for. */
function trapProcessFailures(): { failures: unknown[]; stop(): void } {
  const failures: unknown[] = []
  const onRejection = (reason: unknown): void => {
    failures.push(reason)
  }
  const onException = (error: unknown): void => {
    failures.push(error)
  }
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return {
    failures,
    stop: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    }
  }
}

/** Give timers and microtasks a chance to run, so a late throw would surface. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5))
}

let trap: ReturnType<typeof trapProcessFailures>

beforeEach(() => {
  trap = trapProcessFailures()
})

afterEach(() => {
  trap.stop()
})

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('work that outlives the module it belongs to', () => {
  it('a job still fanning out when the module stops reports nothing', async () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
    const jobs = new FleetJobs(harness.ctx, new HostStore(harness.ctx))
    const gate = deferred()

    jobs.start({
      kind: 'bulk-action',
      label: 'restart nginx everywhere',
      names: ['10.0.0.1', '10.0.0.2'],
      run: async (report) => {
        report('10.0.0.1', true)
        await gate.promise
        // The fan-out only notices the cancellation between batches, so this
        // lands after the module has already gone.
        report('10.0.0.2', true)
      }
    })

    jobs.dispose()
    harness.revoke()
    gate.release()
    await drain()

    expect(trap.failures).toEqual([])
    // The rule the ruleset states: nothing keeps using ctx after dispose().
    expect(harness.afterStopCalls).toEqual([])
  })
})
