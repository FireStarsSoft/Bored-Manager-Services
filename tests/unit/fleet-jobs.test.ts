import { describe, expect, it, vi } from 'vitest'
import { FleetJobs, type ReportFn } from '../../service-fleet/main/jobs'
import {
  HostStore,
  MAX_JOBS,
  MAX_JOB_ITEMS,
  type FleetJob
} from '../../service-fleet/main/store'
import { moduleHarness, type ModuleHarness } from '../helpers/module-harness'

/**
 * The engine behind every fleet-wide action: "restart nginx on 40 machines"
 * returns immediately and the page watches the outcome arrive machine by
 * machine. What the user reads afterwards is entirely this class's summary, so
 * a miscounted failure or an item left `pending` is a job that lied about what
 * it did.
 *
 * The fan-out itself is not exercised here - `run` is handed in, which is what
 * lets a test decide exactly which machines answered, which never did, and
 * when the user pressed Cancel.
 */

function fleet(): { harness: ModuleHarness; jobs: FleetJobs; store: HostStore } {
  const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
  const store = new HostStore(harness.ctx)
  return { harness, jobs: new FleetJobs(harness.ctx, store), store }
}

/** The jobs in the last `jobs` payload the module pushed. */
function pushed(harness: ModuleHarness): FleetJob[] {
  const calls = harness.emit.mock.calls.filter(([event]) => event === 'jobs')
  const last = calls.at(-1)?.[1] as { jobs: FleetJob[] } | undefined
  return last?.jobs ?? []
}

function pushCount(harness: ModuleHarness): number {
  return harness.emit.mock.calls.filter(([event]) => event === 'jobs').length
}

function historyOf(store: HostStore): FleetJob[] {
  return store.read().jobs
}

/** A gate a test opens when it wants the fan-out to carry on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/** Let the job's own `run` promise and the reporting that follows it settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('a fleet job that runs to the end', () => {
  it('counts every machine, finishes done, and moves out of the live list into the history', async () => {
    const { harness, jobs, store } = fleet()

    jobs.start({
      kind: 'unit-action',
      label: 'restart nginx',
      names: ['10.0.0.1', '10.0.0.2'],
      run: async (report) => {
        report('10.0.0.1', true)
        report('10.0.0.2', true)
      }
    })
    expect(jobs.busy).toBe(true)
    await settle()

    expect(jobs.busy).toBe(false)
    const [job] = historyOf(store)
    expect(job).toMatchObject({ state: 'done', total: 2, done: 2, failed: 0, progressPct: 100 })
    expect(job.items.map((i) => i.status)).toEqual(['ok', 'ok'])
    expect(job.finishedAt).toBeGreaterThanOrEqual(job.startedAt)
    expect(pushed(harness)[0]).toMatchObject({ id: job.id, state: 'done' })
  })

  it('is partial when some machines failed and failed when they all did', async () => {
    const { jobs, store } = fleet()
    const answers =
      (oks: boolean[]) =>
      async (report: ReportFn): Promise<void> => {
        oks.forEach((ok, i) => report('10.0.0.' + (i + 1), ok, ok ? undefined : 'exit 1'))
      }

    jobs.start({
      kind: 'k',
      label: 'some',
      names: ['10.0.0.1', '10.0.0.2'],
      run: answers([true, false])
    })
    await settle()
    jobs.start({
      kind: 'k',
      label: 'none',
      names: ['10.0.0.1', '10.0.0.2'],
      run: answers([false, false])
    })
    await settle()

    const [allFailed, someFailed] = historyOf(store)
    expect(allFailed).toMatchObject({ label: 'none', state: 'failed', failed: 2 })
    expect(someFailed).toMatchObject({ label: 'some', state: 'partial', failed: 1 })
    expect(someFailed.items[1]).toMatchObject({ status: 'error', message: 'exit 1' })
  })

  /**
   * The fan-out gives up early when the connection goes or the batch times
   * out. Those machines were never contacted, which is not the same as having
   * been contacted and refusing - the report has to say so.
   */
  it('marks machines the fan-out never reached as skipped, not failed', async () => {
    const { jobs, store } = fleet()

    jobs.start({
      kind: 'k',
      label: 'stopped early',
      names: ['a', 'b', 'c'],
      run: async (report) => {
        report('a', true)
      }
    })
    await settle()

    const [job] = historyOf(store)
    expect(job.items.map((i) => i.status)).toEqual(['ok', 'skipped', 'skipped'])
    expect(job).toMatchObject({ state: 'done', failed: 0, done: 3, progressPct: 100 })
  })

  it('ignores a second report for a machine that answered, and one for a machine not in the job', async () => {
    const { jobs, store } = fleet()

    jobs.start({
      kind: 'k',
      label: 'noisy',
      names: ['a'],
      run: async (report) => {
        report('a', true)
        report('a', false, 'late')
        report('not-in-this-job', false)
      }
    })
    await settle()

    const [job] = historyOf(store)
    expect(job).toMatchObject({ total: 1, done: 1, failed: 0, state: 'done' })
    expect(job.items[0]).toMatchObject({ status: 'ok' })
    expect(job.items[0].message).toBeUndefined()
  })

  /**
   * Nothing awaits `start()`, so a `run` that throws is the case that used to
   * take the server down. The job still has to close itself out, and every
   * machine still waiting has to be told why.
   */
  it('closes out a run that threw, giving its unanswered machines the reason', async () => {
    const { harness, jobs, store } = fleet()

    jobs.start({
      kind: 'k',
      label: 'blew up',
      names: ['a', 'b'],
      run: async (report) => {
        report('a', true)
        throw new Error('ssh: connection reset')
      }
    })
    await settle()

    const [job] = historyOf(store)
    expect(job).toMatchObject({ state: 'partial', failed: 1, done: 2 })
    expect(job.items[1]).toMatchObject({ status: 'error', message: 'ssh: connection reset' })
    expect(harness.afterStopCalls).toEqual([])
  })
})

describe('cancelling a fleet job', () => {
  it('tells the runner between batches and marks what it never got to as cancelled', async () => {
    const { jobs, store } = fleet()
    const batch = gate()
    let seenCancelled = false

    const job = jobs.start({
      kind: 'k',
      label: 'long install',
      names: ['a', 'b', 'c'],
      run: async (report, cancelled) => {
        report('a', true)
        await batch.wait
        seenCancelled = cancelled()
      }
    })

    expect(jobs.cancel(job.id)).toEqual({ ok: true })
    batch.open()
    await settle()

    expect(seenCancelled).toBe(true)
    const [finished] = historyOf(store)
    expect(finished.state).toBe('cancelled')
    expect(finished.items.map((i) => i.status)).toEqual(['ok', 'cancelled', 'cancelled'])
  })

  it('refuses an id that is not running, rather than pretending it stopped something', async () => {
    const { jobs } = fleet()
    const job = jobs.start({
      kind: 'k',
      label: 'quick',
      names: ['a'],
      run: async (report) => report('a', true)
    })
    await settle()

    expect(jobs.cancel(job.id)).toMatchObject({ ok: false })
    expect(jobs.cancel(undefined)).toMatchObject({ ok: false })
  })
})

describe('what the job history is allowed to grow to', () => {
  it('caps the machines in one job, so a mistyped /8 does not become millions of items', async () => {
    const { jobs, store } = fleet()
    const names = Array.from({ length: MAX_JOB_ITEMS + 25 }, (_, i) => 'm' + i)

    jobs.start({ kind: 'k', label: 'too wide', names, run: async () => {} })
    await settle()

    const [job] = historyOf(store)
    expect(job.total).toBe(MAX_JOB_ITEMS)
    expect(job.items.length).toBeLessThanOrEqual(MAX_JOB_ITEMS)
  })

  /**
   * A finished job is kept for its failures. Trimming has to keep those and
   * drop the "ok" lines, in the original machine order - a list that jumps
   * around is unreadable next to the one the user just watched.
   */
  it('keeps the failures when a finished job is trimmed for the history', async () => {
    const { jobs, store } = fleet()
    const names = Array.from({ length: 60 }, (_, i) => 'm' + i)

    const live = jobs.start({
      kind: 'k',
      label: 'wide',
      names,
      run: async (report) => {
        names.forEach((name, i) => {
          const bad = i === 7 || i === 55
          report(name, !bad, bad ? 'failed' : undefined)
        })
      }
    })
    expect(live.items).toHaveLength(60)
    await settle()

    const [job] = historyOf(store)
    expect(job.total).toBe(60)
    expect(job.failed).toBe(2)
    expect(job.items.length).toBeLessThan(60)
    expect(job.items.filter((i) => i.status === 'error').map((i) => i.name)).toEqual(['m7', 'm55'])
    const idx = job.items.map((i) => i.idx)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })

  it('keeps only the most recent jobs once the history is full', async () => {
    const { jobs, store } = fleet()

    for (let i = 0; i < MAX_JOBS + 5; i++) {
      jobs.start({
        kind: 'k',
        label: 'job ' + i,
        names: ['a'],
        run: async (report) => report('a', true)
      })
      await settle()
    }

    const history = historyOf(store)
    expect(history).toHaveLength(MAX_JOBS)
    expect(history[0].label).toBe('job ' + (MAX_JOBS + 4))
  })

  it('clears the finished jobs and leaves a running one alone', async () => {
    const { jobs, store } = fleet()
    const running = gate()
    jobs.start({ kind: 'k', label: 'done', names: ['a'], run: async (report) => report('a', true) })
    await settle()
    jobs.start({ kind: 'k', label: 'still going', names: ['a'], run: async () => running.wait })
    await settle()

    expect(jobs.clearFinished()).toEqual({ ok: true, data: '1' })

    expect(historyOf(store)).toEqual([])
    expect(jobs.list().map((j) => j.label)).toEqual(['still going'])
    running.open()
    await settle()
  })
})

describe('how often progress is pushed', () => {
  /**
   * One push per machine across a /24 is 254 frames of a growing payload for
   * something the user reads as a progress bar. The transitions - a job
   * starting, a job ending - are the ones that must not be dropped, and the
   * last state of a burst must not be the one that is.
   */
  it('coalesces a burst of reports into one push and still delivers the final count', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-24T10:00:00Z') })
    try {
      const { harness, jobs } = fleet()
      const names = Array.from({ length: 20 }, (_, i) => 'm' + i)
      const running = gate()

      jobs.start({
        kind: 'k',
        label: 'burst',
        names,
        run: async (report) => {
          names.forEach((name) => report(name, true))
          await running.wait
        }
      })
      await settle()

      expect(pushCount(harness)).toBe(1)

      await vi.advanceTimersByTimeAsync(600)
      expect(pushCount(harness)).toBe(2)
      expect(pushed(harness)[0]).toMatchObject({ done: 20, progressPct: 100, state: 'running' })

      running.open()
      await settle()
      expect(pushed(harness)[0]).toMatchObject({ state: 'done' })
    } finally {
      vi.useRealTimers()
    }
  })
})
