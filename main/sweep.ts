/**
 * The one thing that touches the network on a timer: ask every configured
 * address what it is running, fold the answers into the roster, and publish what
 * the pages read.
 *
 * It runs on the **slow** interval, not the fast one. A fan-out over a subnet
 * takes seconds and shares one SSH connection with the app's own collectors, so
 * "every two minutes" is the honest cadence; the fast interval is only how often
 * the browser re-reads the result this already computed.
 */
import type { ModuleContext, ModulePoller } from '@shared/modules'
import { resolveCredential, type FleetConfig } from './config'
import { classifyReach, reachMessage, runFanout, type FanoutTarget } from './fanout'
import { enumerateRule } from './net'
import type { JumpCapabilities } from './probe'
import type { Roster, HostsPayload } from './roster'
import type { FleetRules } from './rules'
import { parseSweep, sweepCompleted, sweepPayload, type HostFacts } from './units'

export interface SweepStatus {
  t: number
  state: 'idle' | 'running' | 'cancelled' | 'error'
  done: number
  total: number
  startedAt: number | null
  finishedAt: number | null
  durationMs: number
  message: string
}

export interface SeriesPoint {
  t: number
  online: number
  offline: number
  degraded: number
  failed: number
}

/** Five minutes, matching the live buffer a `series` stream keeps. */
const SERIES_MS = 5 * 60 * 1000

export interface TargetPlan {
  targets: FanoutTarget[]
  problems: string[]
}

/**
 * Which addresses this sweep will ask, and who as. An address covered by two
 * rules is asked once, with the narrowest rule's credentials - so one machine
 * given its own login inside a subnet-wide rule is reached the way the user
 * meant, not twice.
 */
export function planTargets(config: FleetConfig, rules: FleetRules): TargetPlan {
  const targets: FanoutTarget[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const rule of config.targets) {
    if (!rule.enabled) continue
    const listed = enumerateRule(rule.kind, rule.value, rules.maxHosts)
    if (listed.problem) {
      problems.push(`${rule.value}: ${listed.problem}`)
      continue
    }
    if (listed.truncated) {
      problems.push(
        `${rule.value} covers ${listed.total} addresses; only the first ${listed.ips.length} are swept (raise "Largest address range" to change that).`
      )
    }
    for (const ip of listed.ips) {
      if (seen.has(ip)) continue
      const cred = resolveCredential(ip, config.targets)
      if (!cred) continue
      seen.add(ip)
      targets.push({ ip, cred })
    }
  }
  return { targets, problems }
}

export class Sweeper {
  readonly poller: ModulePoller
  latest: HostsPayload | null = null
  series: SeriesPoint[] = []
  status: SweepStatus = {
    t: Date.now(),
    state: 'idle',
    done: 0,
    total: 0,
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    message: 'Not swept yet.'
  }

  private inFlight: Promise<void> | null = null
  private cancelRequested = false

  constructor(
    private ctx: ModuleContext,
    private roster: Roster,
    private deps: {
      config: () => FleetConfig
      rules: () => FleetRules
      capabilities: () => JumpCapabilities
    }
  ) {
    this.poller = ctx.createPoller('sweep', () => this.run())
  }

  /** One sweep at a time: a manual refresh joins the tick already in progress. */
  run(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.sweep().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  cancel(): void {
    if (this.inFlight) this.cancelRequested = true
  }

  reset(): void {
    this.cancelRequested = false
    this.latest = null
    this.series = []
    this.status = {
      t: Date.now(),
      state: 'idle',
      done: 0,
      total: 0,
      startedAt: null,
      finishedAt: null,
      durationMs: 0,
      message: 'Not swept yet.'
    }
  }

  /**
   * Re-read one machine and republish. Called after an action so the row the
   * user just changed shows its new state now, instead of at the next sweep two
   * minutes later.
   */
  async refreshOne(ip: string): Promise<void> {
    if (!this.ctx.connected) return
    const config = this.deps.config()
    const rules = this.deps.rules()
    const cred = resolveCredential(ip, config.targets)
    if (!cred) return
    const results = await runFanout(this.ctx, [{ ip, cred }], sweepPayload(config.watched, rules), rules)
    const result = results[0]
    if (!result) return
    const reach = classifyReach(result)
    const facts = reach === 'ok' && sweepCompleted(result.stdout) ? parseSweep(result.stdout, rules.maxUnitsPerHost) : null
    this.roster.applyOne({ ip, cred, reach, reachMessage: reachMessage(reach, result), facts }, config.watched, rules)
    this.publishCards(rules)
  }

  private setStatus(patch: Partial<SweepStatus>): void {
    this.status = { ...this.status, ...patch, t: Date.now() }
    this.ctx.emit('sweep', this.status)
  }

  /** The wall, and nothing else - safe to call after a single machine changed. */
  private publishCards(rules: FleetRules): HostsPayload {
    const payload = this.roster.cards(rules)
    this.latest = payload
    this.ctx.emit('hosts', payload)
    return payload
  }

  /**
   * The wall plus one point of history. Only a full sweep does this: a point per
   * action would put spikes in the chart that mean nothing but "somebody pressed
   * a button".
   */
  private publish(rules: FleetRules): void {
    const payload = this.publishCards(rules)
    const point: SeriesPoint = {
      t: payload.t,
      online: payload.counts.online,
      offline: payload.counts.offline,
      degraded: payload.counts.degraded,
      failed: payload.counts.unitsFailed
    }
    this.series.push(point)
    const cutoff = point.t - SERIES_MS
    while (this.series.length && this.series[0].t < cutoff) this.series.shift()
    this.ctx.emit('series', point)
    this.ctx.addHistory({
      t: point.t,
      online: point.online,
      offline: point.offline,
      degraded: point.degraded,
      unitsRunning: payload.counts.unitsRunning,
      unitsFailed: payload.counts.unitsFailed
    })
  }

  private async sweep(): Promise<void> {
    if (!this.ctx.connected) return
    const rules = this.deps.rules()
    const config = this.deps.config()
    const capabilities = this.deps.capabilities()
    if (capabilities.problem) {
      this.setStatus({ state: 'error', message: capabilities.problem, done: 0, total: 0 })
      return
    }
    const plan = planTargets(config, rules)
    if (plan.targets.length === 0) {
      this.roster.apply([], config.watched, rules)
      this.publish(rules)
      this.setStatus({
        state: 'idle',
        done: 0,
        total: 0,
        message: plan.problems[0] ?? 'No addresses configured yet - add one in Module settings.'
      })
      return
    }

    this.cancelRequested = false
    const startedAt = Date.now()
    this.setStatus({
      state: 'running',
      done: 0,
      total: plan.targets.length,
      startedAt,
      finishedAt: null,
      message: `Sweeping ${plan.targets.length} addresses…`
    })

    const payload = sweepPayload(config.watched, rules)
    let results
    try {
      results = await runFanout(this.ctx, plan.targets, payload, rules, {
        onProgress: (done, total) => this.setStatus({ done, total }),
        cancelled: () => this.cancelRequested
      })
    } catch (err) {
      this.setStatus({
        state: 'error',
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err)
      })
      return
    }

    const byIp = new Map(plan.targets.map((target) => [target.ip, target]))
    const entries = results.map((result) => {
      const target = byIp.get(result.ip)
      const reach = classifyReach(result)
      let facts: HostFacts | null = null
      if (reach === 'ok') {
        facts = parseSweep(result.stdout, rules.maxUnitsPerHost)
        // A truncated answer (the connection dropped mid-script) would otherwise
        // read as "this machine runs no services at all".
        if (!sweepCompleted(result.stdout)) facts = null
      }
      return {
        ip: result.ip,
        cred: target?.cred ?? plan.targets[0].cred,
        reach,
        reachMessage: reachMessage(reach, result),
        facts
      }
    })

    this.roster.apply(entries, config.watched, rules)
    this.publish(rules)
    const reached = entries.filter((entry) => entry.reach === 'ok').length
    const durationMs = Date.now() - startedAt
    this.setStatus({
      state: this.cancelRequested ? 'cancelled' : 'idle',
      done: entries.length,
      total: plan.targets.length,
      finishedAt: Date.now(),
      durationMs,
      message: this.cancelRequested
        ? `Cancelled after ${entries.length} of ${plan.targets.length} addresses.`
        : `${reached} of ${entries.length} addresses answered in ${Math.round(durationMs / 100) / 10}s.${
            plan.problems.length ? ` ${plan.problems[0]}` : ''
          }`
    })
    this.cancelRequested = false
  }
}
