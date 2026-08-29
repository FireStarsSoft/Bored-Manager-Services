/**
 * Turning stored rows into what the Reports page draws.
 *
 * Every join, filter and sum happens here rather than in a spec, because a spec
 * cannot do any of them - a block renders what it is given. That is also why
 * the chart series are built into `{ t, ... }` points here: a `chart` block
 * with an `invoke` source expects points, and the record store answers with
 * rows.
 *
 * The `partial` flag is carried the whole way through. A day that mixes exact
 * container counters with a floor from socket accounting is still a floor, and
 * the page says so rather than presenting a sum as though every byte in it were
 * measured the same way.
 */
import type { ModuleContext, ModuleRecord } from '@shared/modules'
import { BADGE, badge, statusBadges } from '../badges'
import { DAILY_SET, EVENTS_SET } from './collect'

const DAY_MS = 86_400_000

export interface ReportWindow {
  days: number
  since: number
}

export function windowOf(days: unknown, fallback = 30): ReportWindow {
  const parsed = typeof days === 'number' ? Math.trunc(days) : Number.parseInt(String(days ?? ''), 10)
  const resolved = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 400) : fallback
  return { days: resolved, since: Date.now() - resolved * DAY_MS }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function readAll(
  ctx: ModuleContext,
  set: string,
  since: number,
  key?: string
): Promise<ModuleRecord[]> {
  const out: ModuleRecord[] = []
  let cursor: string | undefined
  // Paged rather than one big read: a year of a large fleet is more rows than
  // one page may answer with, and a silent truncation would make a chart wrong
  // rather than short.
  for (let page = 0; page < 20; page++) {
    const answer = await ctx.recordQuery(set, { from: since, key, limit: 5000, cursor })
    out.push(...answer.rows)
    if (!answer.next) break
    cursor = answer.next
  }
  return out
}

/** Only the per-unit rows; the per-host rows are a different shape. */
function unitRows(rows: readonly ModuleRecord[]): ModuleRecord[] {
  return rows.filter((row) => row['scope'] === 'unit')
}

function hostRows(rows: readonly ModuleRecord[]): ModuleRecord[] {
  return rows.filter((row) => row['scope'] === 'host')
}

export interface ReportDeps {
  ctx: ModuleContext
  /** A machine's label, for a row a person can read. */
  labelFor(ip: string): string
}

export class Reports {
  constructor(private deps: ReportDeps) {}

  /** One row per machine per day: what it moved, and how much of the day it was up. */
  async bandwidthRows(days: unknown, key?: string): Promise<Array<Record<string, unknown>>> {
    const window = windowOf(days)
    const rows = unitRows(await readAll(this.deps.ctx, DAILY_SET, window.since, key))
    return rows
      .map((row) => {
        const ip = str(row['key'])
        const rx = num(row['rx'])
        const tx = num(row['tx'])
        return {
          key: `${ip}|${str(row['day'])}|${str(row['template'])}|${str(row['unit'])}`,
          t: row.t,
          day: str(row['day']),
          ip,
          label: this.deps.labelFor(ip),
          template: str(row['template']),
          unit: str(row['unit']),
          rx,
          tx,
          bytes: rx + tx,
          partial: row['partial'] === true,
          // A floor is not a total, and a table that did not say so would be
          // read as one. The chip is the only honest way to put it in a cell.
          partialBadges: row['partial'] === true ? [badge('floor', BADGE.warn)] : [],
          uptimePct: Math.round(num(row['uptimeRatio']) * 1000) / 10,
          restarts: num(row['restarts'])
        }
      })
      .sort((a, b) => (b.t as number) - (a.t as number) || String(a.ip).localeCompare(String(b.ip)))
  }

  /**
   * Daily totals across the fleet, as chart points.
   *
   * One point per day rather than per row: a `chart` plots a series against
   * time, and several rows sharing a timestamp would draw one of them and drop
   * the rest.
   */
  async bandwidthSeries(days: unknown, key?: string): Promise<Array<Record<string, number>>> {
    const window = windowOf(days)
    const rows = unitRows(await readAll(this.deps.ctx, DAILY_SET, window.since, key))
    const byDay = new Map<string, { t: number; rx: number; tx: number }>()
    for (const row of rows) {
      const day = str(row['day']) || String(row.t)
      const bucket = byDay.get(day) ?? { t: row.t, rx: 0, tx: 0 }
      bucket.rx += num(row['rx'])
      bucket.tx += num(row['tx'])
      byDay.set(day, bucket)
    }
    return [...byDay.values()]
      .sort((a, b) => a.t - b.t)
      .map((point) => ({ t: point.t, rx: point.rx, tx: point.tx, total: point.rx + point.tx }))
  }

  /** One row per machine per day: how much of it the machine was online. */
  async uptimeRows(days: unknown, key?: string): Promise<Array<Record<string, unknown>>> {
    const window = windowOf(days)
    const rows = hostRows(await readAll(this.deps.ctx, DAILY_SET, window.since, key))
    return rows
      .map((row) => {
        const ip = str(row['key'])
        const online = Math.round(num(row['onlineRatio']) * 1000) / 10
        const events = (row['events'] ?? {}) as Record<string, unknown>
        const incidents = Object.values(events).reduce<number>((sum, value) => sum + num(value), 0)
        return {
          key: `${ip}|${str(row['day'])}`,
          t: row.t,
          day: str(row['day']),
          ip,
          label: this.deps.labelFor(ip),
          onlinePct: online,
          // The colour is the fleet's own judgement, not the agent's: anything
          // below 99% of a day is more than fifteen minutes offline.
          onlineBadges: statusBadges(online >= 99 ? 'online' : online >= 95 ? 'degraded' : 'offline'),
          latencyP50: num(row['latencyP50']) || null,
          latencyP95: num(row['latencyP95']) || null,
          latencyMax: num(row['latencyMax']) || null,
          publicIps: Array.isArray(row['publicIps']) ? (row['publicIps'] as string[]).join(', ') : '',
          incidents,
          samples: num(row['samples'])
        }
      })
      .sort((a, b) => (b.t as number) - (a.t as number) || String(a.ip).localeCompare(String(b.ip)))
  }

  /** Fleet uptime over the window, as one number for a meter. */
  async uptimeSummary(days: unknown): Promise<Record<string, unknown>> {
    const window = windowOf(days)
    const rows = hostRows(await readAll(this.deps.ctx, DAILY_SET, window.since))
    if (!rows.length) {
      return { days: window.days, machines: 0, onlinePct: null, incidents: 0, message: 'Nothing collected yet.' }
    }
    const machines = new Set(rows.map((row) => str(row['key'])))
    const online = rows.reduce((sum, row) => sum + num(row['onlineRatio']), 0) / rows.length
    const incidents = rows.reduce((sum, row) => {
      const events = (row['events'] ?? {}) as Record<string, unknown>
      return sum + Object.values(events).reduce<number>((inner, value) => inner + num(value), 0)
    }, 0)
    return {
      days: window.days,
      machines: machines.size,
      onlinePct: Math.round(online * 1000) / 10,
      incidents,
      rows: rows.length,
      message: `${machines.size} machine(s) over ${window.days} day(s).`
    }
  }

  /** The incident log, newest first. */
  async incidentRows(days: unknown, kind?: unknown, key?: string): Promise<Array<Record<string, unknown>>> {
    const window = windowOf(days, 7)
    const wanted = typeof kind === 'string' && kind && kind !== 'any' ? kind : null
    const rows = await readAll(this.deps.ctx, EVENTS_SET, window.since, key)
    return rows
      .filter((row) => !wanted || str(row['kind']) === wanted)
      .map((row) => {
        const ip = str(row['key'])
        const kindName = str(row['kind'])
        return {
          key: `${ip}|${row.t}|${kindName}`,
          t: row.t,
          ip,
          label: this.deps.labelFor(ip),
          kind: kindName,
          kindBadges: [badge(kindName, incidentColour(kindName))],
          template: str(row['template']),
          unit: str(row['unit']),
          detail: describeIncident(row)
        }
      })
      .sort((a, b) => (b.t as number) - (a.t as number))
  }

  /** Which kinds actually occurred, so the filter offers real choices. */
  async incidentKinds(days: unknown): Promise<string[]> {
    const window = windowOf(days, 7)
    const rows = await readAll(this.deps.ctx, EVENTS_SET, window.since)
    return [...new Set(rows.map((row) => str(row['kind'])).filter(Boolean))].sort()
  }

  /** What this module is storing, for the settings page. */
  async usage(): Promise<Record<string, unknown>> {
    const usage = await this.deps.ctx.storageUsage()
    const grant = this.deps.ctx.storageGrant()
    return {
      totalBytes: usage.totalBytes,
      recordBytes: usage.recordBytes,
      configBytes: usage.configBytes,
      hostDataBytes: usage.hostDataBytes,
      historyBytes: usage.historyBytes,
      sets: usage.sets.map((set) => ({
        id: set.id,
        label: set.label,
        bytes: set.bytes,
        grantedBytes: set.grantedBytes,
        rows: set.rows,
        oldestMs: set.oldestMs,
        newestMs: set.newestMs,
        retentionDays: grant.records.find((entry) => entry.id === set.id)?.retentionDays ?? null
      }))
    }
  }
}

function incidentColour(kind: string): string {
  switch (kind) {
    case 'link_down':
    case 'unit_crash':
      return BADGE.bad
    case 'unit_down':
    case 'latency_spike':
    case 'agent_gap':
      return BADGE.warn
    case 'link_up':
    case 'unit_up':
      return BADGE.good
    case 'ip_changed':
      return BADGE.busy
    default:
      return BADGE.missing
  }
}

/** One sentence per incident, so the table reads without a drawer. */
function describeIncident(row: ModuleRecord): string {
  switch (str(row['kind'])) {
    case 'ip_changed':
      return `public address moved from ${str(row['from'])} to ${str(row['to'])}`
    case 'link_down':
      return 'the machine stopped reaching the internet'
    case 'link_up':
      return 'the machine reached the internet again'
    case 'latency_spike':
      return `latency reached ${num(row['peakMs'])} ms against a ${num(row['baselineMs'])} ms baseline, for ${Math.round(
        num(row['durationMs']) / 1000
      )}s`
    case 'unit_down':
      return `${str(row['unit'])} went ${str(row['state'])}${row['crashed'] === true ? ' after a non-zero exit' : ''}`
    case 'unit_up':
      return `${str(row['unit'])} started again`
    case 'unit_crash':
      return `${str(row['unit'])} restarted ${num(row['restarts'])} time(s)`
    case 'agent_gap':
      return `the agent was not sampling for ${Math.round(num(row['durationMs']) / 60000)} minute(s) - that time counts as neither up nor down`
    default:
      return ''
  }
}
