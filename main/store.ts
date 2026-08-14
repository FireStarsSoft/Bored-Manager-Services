/**
 * What this module remembers about the machines reachable from **one** jump
 * host: the roster of addresses that have answered at least once, and the
 * history of jobs run from here.
 *
 * It is per-host data (`ctx.hostDataGet/Set`) rather than module config because
 * it is an observation from one vantage point, not a preference: point the app
 * at a different jump host and the same subnet may be a different set of
 * machines, or none at all. What the user typed lives in `config.ts`.
 *
 * Live unit lists are **not** in here. They are in memory only: 254 machines
 * with 30 services each would be past the 512 KB cap on the first write, and a
 * service state from ten minutes ago is worse than no service state.
 */
import type { ModuleContext } from '@shared/modules'
import { ipToInt } from './net'

export type Reachability =
  | 'unknown'
  | 'ok'
  | 'auth'
  | 'refused'
  | 'unreachable'
  | 'timeout'
  | 'hostkey'
  | 'no-sshpass'
  | 'error'

export interface HostRecord {
  ip: string
  /** From the rule that covers it, kept so a forgotten rule still explains the row. */
  label?: string
  hostname?: string
  os?: string
  kernel?: string
  firstSeen: number
  /** Last time SSH actually worked. Null means it never has. */
  lastSeen: number | null
  lastProbeAt: number | null
  reach: Reachability
  /** Why it is in that state, in one sentence. Regenerated on every sweep. */
  reachNote: string
  /**
   * Named by the user as a single address rather than found inside a range.
   * A pinned address keeps its card even while it has never answered - that is
   * the difference between "this machine is down" and "nothing lives at .137".
   */
  pinned: boolean
}

export type JobItemStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'cancelled'

export interface JobItem {
  idx: number
  /** The machine, or the machine and unit, this item was about. */
  name: string
  status: JobItemStatus
  message?: string
  ms?: number
}

export type JobState = 'running' | 'done' | 'failed' | 'partial' | 'cancelled'

export interface FleetJob {
  id: string
  kind: string
  label: string
  state: JobState
  startedAt: number
  finishedAt?: number
  total: number
  done: number
  failed: number
  /** Precomputed: a `table` column cannot divide two other columns. */
  progressPct: number
  items: JobItem[]
}

export interface FleetHostData {
  version: 1
  hosts: Record<string, HostRecord>
  jobs: FleetJob[]
}

export const MAX_JOBS = 50
export const MAX_JOB_ITEMS = 200
/** A roster larger than this stops being a fleet page and starts being a scan report. */
export const MAX_HOST_RECORDS = 1024

function emptyData(): FleetHostData {
  return { version: 1, hosts: {}, jobs: [] }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const REACH_VALUES: Reachability[] = [
  'unknown',
  'ok',
  'auth',
  'refused',
  'unreachable',
  'timeout',
  'hostkey',
  'no-sshpass',
  'error'
]

/** Read defensively: a user can edit this file, and an older build may have written it. */
function normalize(raw: unknown): FleetHostData {
  if (typeof raw !== 'object' || raw === null) return emptyData()
  const r = raw as Partial<FleetHostData>
  const hosts: Record<string, HostRecord> = {}
  let kept = 0
  for (const [ip, entry] of Object.entries(r.hosts ?? {})) {
    if (kept >= MAX_HOST_RECORDS) break
    if (typeof entry !== 'object' || entry === null) continue
    if (ipToInt(ip) == null) continue
    const h = entry as Partial<HostRecord>
    kept++
    hosts[ip] = {
      ip,
      label: asString(h.label) || undefined,
      hostname: asString(h.hostname) || undefined,
      os: asString(h.os) || undefined,
      kernel: asString(h.kernel) || undefined,
      firstSeen: asNumberOrNull(h.firstSeen) ?? 0,
      lastSeen: asNumberOrNull(h.lastSeen),
      lastProbeAt: asNumberOrNull(h.lastProbeAt),
      reach: REACH_VALUES.includes(h.reach as Reachability) ? (h.reach as Reachability) : 'unknown',
      reachNote: asString(h.reachNote),
      pinned: h.pinned === true
    }
  }
  const jobs = (Array.isArray(r.jobs) ? r.jobs : []).filter(
    (job): job is FleetJob => typeof job === 'object' && job !== null && typeof (job as FleetJob).id === 'string'
  )
  return { version: 1, hosts, jobs: jobs.slice(0, MAX_JOBS) }
}

/**
 * Reads through a cache tied to the machine it was read for: reconnecting
 * somewhere else has to see that jump host's roster, not the previous one's.
 */
export class HostStore {
  private cache: FleetHostData | null = null
  private cachedFor: string | null = null

  constructor(private ctx: ModuleContext) {}

  read(): FleetHostData {
    const host = this.ctx.hostKey
    if (this.cache && this.cachedFor === host) return this.cache
    this.cache = normalize(this.ctx.hostDataGet())
    this.cachedFor = host
    return this.cache
  }

  /**
   * Mutate the document and persist it. A failed write (over the size cap, a
   * read-only app folder) leaves the change in memory rather than throwing away
   * what the user just did; the next successful write puts the two back in step.
   */
  update<T>(mutate: (data: FleetHostData) => T): T {
    const result = mutate(this.read())
    this.persist()
    return result
  }

  /**
   * Write what is in memory. Separate from `update` because a sweep touches the
   * document on every tick (a probe time moves) but only sometimes says
   * something new - and a write per tick is exactly what the module rules say
   * not to do.
   */
  persist(): void {
    const data = this.read()
    try {
      this.ctx.hostDataSet(data)
    } catch (err) {
      // Job history is the part that can grow without bound, so that is the
      // part that gets trimmed before giving up on the write entirely.
      this.ctx.log(`service-fleet: could not save host data (${err instanceof Error ? err.message : String(err)})`)
      data.jobs = data.jobs.slice(0, 5)
      try {
        this.ctx.hostDataSet(data)
      } catch {
        /* stays in memory */
      }
    }
  }

  reset(): void {
    this.cache = null
    this.cachedFor = null
  }
}

export function makeJobId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 6)}`
}
