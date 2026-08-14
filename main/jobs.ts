/**
 * Anything that changes something on more than one machine, and lets the user
 * watch it happen. Apply methods start a job and return straight away: an
 * install across twenty machines takes minutes, and an RPC call that waits that
 * long is a call that times out.
 *
 * The engine here is thinner than a job runner usually is, because the
 * parallelism lives one layer down: `runFanout` already contacts machines
 * `maxParallel` at a time. A job is one item per machine plus a single `run`
 * that reports outcomes as the batches come back.
 */
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { MAX_JOBS, MAX_JOB_ITEMS, makeJobId, type FleetJob, type HostStore } from './store'

export type ReportFn = (name: string, ok: boolean, message?: string) => void

export interface JobSpec {
  kind: string
  label: string
  /** One per machine, in the order they will be contacted. */
  names: string[]
  run: (report: ReportFn, cancelled: () => boolean) => Promise<void>
}

/** How often progress is pushed while a job runs; every machine would be a lot of traffic. */
const EMIT_THROTTLE_MS = 500

/**
 * A running job keeps every item so the user can watch it; the copy that goes
 * into the history does not. Fifty untrimmed jobs would not fit in the per-host
 * document, and a finished job's two hundred "ok" lines are not what anyone
 * comes back for - the failures are.
 */
const HISTORY_ITEMS_PER_JOB = 40

function forHistory(job: FleetJob): FleetJob {
  if (job.items.length <= HISTORY_ITEMS_PER_JOB) return job
  const bad = job.items.filter((i) => i.status === 'error' || i.status === 'cancelled')
  const rest = job.items.filter((i) => i.status !== 'error' && i.status !== 'cancelled')
  const kept = [...bad.slice(0, HISTORY_ITEMS_PER_JOB), ...rest].slice(0, HISTORY_ITEMS_PER_JOB)
  return { ...job, items: kept.sort((a, b) => a.idx - b.idx) }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class FleetJobs {
  /** Jobs that have not finished, newest first; finished ones move to the host store. */
  private live: FleetJob[] = []
  private cancelling = new Set<string>()
  private lastEmit = 0
  private emitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private ctx: ModuleContext,
    private store: HostStore
  ) {}

  /** Running jobs first, then what the host store remembers. */
  list(): FleetJob[] {
    return [...this.live, ...this.store.read().jobs]
  }

  snapshot(): { t: number; jobs: FleetJob[] } {
    return { t: Date.now(), jobs: this.list() }
  }

  get busy(): boolean {
    return this.live.length > 0
  }

  /**
   * Switching the module off has to stop its work. The runner checks between
   * batches, so machines already being contacted finish - a half-installed
   * package is worse than a slightly late stop - and no new batch starts.
   */
  dispose(): void {
    for (const job of this.live) this.cancelling.add(job.id)
    this.live = []
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
  }

  /** The connection these were running over has gone; they cannot be resumed. */
  reset(): void {
    this.dispose()
  }

  start(spec: JobSpec): FleetJob {
    const job: FleetJob = {
      id: makeJobId(),
      kind: spec.kind,
      label: spec.label,
      state: 'running',
      startedAt: Date.now(),
      total: Math.min(spec.names.length, MAX_JOB_ITEMS),
      done: 0,
      failed: 0,
      progressPct: 0,
      items: spec.names.slice(0, MAX_JOB_ITEMS).map((name, idx) => ({ idx, name, status: 'pending' as const }))
    }
    this.live.unshift(job)
    this.emit(true)
    void this.run(job, spec)
    return job
  }

  cancel(id: unknown): OkResult {
    const jobId = String(id ?? '')
    const job = this.live.find((j) => j.id === jobId)
    if (!job) return { ok: false, error: 'no such job, or it has already finished' }
    this.cancelling.add(jobId)
    this.ctx.log(`service-fleet: job ${jobId} (${job.label}) cancelled by the user`)
    this.emit(true)
    return { ok: true }
  }

  /** Drop the finished jobs from the history; the running ones stay. */
  clearFinished(): OkResult {
    const removed = this.store.update((data) => {
      const count = data.jobs.length
      data.jobs = []
      return count
    })
    this.emit(true)
    return { ok: true, data: `${removed}` }
  }

  private async run(job: FleetJob, spec: JobSpec): Promise<void> {
    const cancelled = (): boolean => this.cancelling.has(job.id)
    const byName = new Map(job.items.map((item) => [item.name, item]))

    const report: ReportFn = (name, ok, text) => {
      const item = byName.get(name)
      if (!item || item.status !== 'pending') return
      item.status = ok ? 'ok' : 'error'
      if (text) item.message = text
      item.ms = Date.now() - job.startedAt
      job.done++
      if (!ok) job.failed++
      job.progressPct = job.total ? Math.round((job.done / job.total) * 100) : 100
      this.emit()
    }

    try {
      await spec.run(report, cancelled)
    } catch (err) {
      this.ctx.log(`service-fleet: job ${job.id} stopped unexpectedly: ${message(err)}`)
      for (const item of job.items) {
        if (item.status !== 'pending') continue
        item.status = 'error'
        item.message = message(err)
        job.done++
        job.failed++
      }
    }

    // Anything the runner never got to: cancelled if the user asked, skipped if
    // the fan-out stopped early (the connection went, the sweep timed out).
    for (const item of job.items) {
      if (item.status !== 'pending') continue
      item.status = cancelled() ? 'cancelled' : 'skipped'
      job.done++
    }

    job.finishedAt = Date.now()
    job.progressPct = 100
    job.state = cancelled()
      ? 'cancelled'
      : job.failed === 0
        ? 'done'
        : job.failed === job.total
          ? 'failed'
          : 'partial'
    this.cancelling.delete(job.id)
    this.live = this.live.filter((j) => j.id !== job.id)
    this.persist(job)
    this.ctx.log(
      `service-fleet: job ${job.id} (${job.label}) ${job.state}: ${job.total - job.failed}/${job.total} ok`
    )
    this.emit(true)
  }

  /**
   * Move a finished job into the history. The document has a hard size ceiling,
   * so if fifty trimmed jobs still do not fit, the oldest go rather than the one
   * that just finished being the one that is lost.
   */
  private persist(job: FleetJob): void {
    const entry = forHistory(job)
    try {
      this.store.update((data) => {
        data.jobs.unshift(entry)
        data.jobs = data.jobs.slice(0, MAX_JOBS)
      })
      return
    } catch (err) {
      this.ctx.log(`service-fleet: job history did not fit, keeping only the most recent: ${message(err)}`)
    }
    try {
      // The failed update already put this job at the front of the in-memory
      // copy, so cutting the list short keeps it and drops the old ones.
      this.store.update((data) => {
        data.jobs = data.jobs.slice(0, 10)
      })
    } catch (err) {
      this.ctx.log(`service-fleet: job history could not be written at all: ${message(err)}`)
    }
  }

  /**
   * Push progress, at most every half second unless `now` says this is a
   * transition the page must not miss. A trailing emit is scheduled when a push
   * is skipped, so the last state of a burst is never the one dropped.
   */
  private emit(now = false): void {
    const since = Date.now() - this.lastEmit
    if (!now && since < EMIT_THROTTLE_MS) {
      if (!this.emitTimer) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = null
          this.emit(true)
        }, EMIT_THROTTLE_MS - since)
      }
      return
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.lastEmit = Date.now()
    this.ctx.emit('jobs', this.snapshot())
  }
}
