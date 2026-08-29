/**
 * The one thing that touches the network on a timer: ask every configured
 * address who it is, ask every agent what it is running, fold both into the
 * roster, and publish what the pages read.
 *
 * Two passes, and the split is the point:
 *
 * 1. **SSH** to every configured address. This is what finds machines, and the
 *    only thing that can tell "nothing is at .137" from "a machine is there and
 *    refuses the login". It is expensive, which is why it now carries a tiny
 *    payload instead of a unit list.
 * 2. **HTTP** to the addresses that answered, through curl on the jump host.
 *    Everything an installed agent knows comes back this way, at a fraction of
 *    the cost of a second SSH session.
 *
 * It runs on the **slow** interval, not the fast one. A fan-out over a subnet
 * takes seconds and shares one connection with the app's own collectors, so
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
import { detectAgents, type AgentTarget } from './agent/detect'
import type { AgentInfo } from './agent/types'
import { HOST_PROBE_SCRIPT, parseHostProbe, probeCompleted } from './hostprobe'

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
  ready: number
  noAgent: number
  unreachable: number
  running: number
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
  /** Owned by the sweep currently running, so `cancel()` can kill its in-flight batch instead of only stopping the next one. */
  private abortController: AbortController | null = null
  /**
   * True once the module has been stopped. A sweep can sit in `runFanout` for
   * the whole sweep timeout, and by the time it comes back the context may be
   * revoked - so everything after an await checks this before emitting,
   * logging or writing.
   */
  private stopped = false

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
    if (!this.inFlight) return
    this.cancelRequested = true
    // Aborts whichever batch runFanout is waiting on right now. Without this,
    // the jump host kept fanning out to the fleet for up to sweepTimeoutSec
    // after a cancel (or a module disable, via stop() below) because
    // cancelRequested alone is only checked between batches.
    this.abortController?.abort()
  }

  /** The module is going away: stop reporting on work that is still in flight. */
  stop(): void {
    this.stopped = true
    this.cancel()
  }

  reset(): void {
    // reset() means "the machine changed", not "the module is gone": the
    // instance keeps running, so it may report again.
    this.stopped = false
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
    const results = await runFanout(this.ctx, [{ ip, cred }], HOST_PROBE_SCRIPT, rules)
    const result = results[0]
    if (!result) return
    const reach = classifyReach(result)
    const complete = reach === 'ok' && probeCompleted(result.stdout)
    let agent: AgentInfo | null = null
    if (complete) {
      const found = await this.detect([{ ip, port: rules.agentPort, token: this.roster.tokenFor(ip) }], rules)
      agent = found.get(ip) ?? null
    }
    this.roster.applyOne(
      {
        ip,
        cred,
        reach,
        reachMessage: reachMessage(reach, result),
        facts: complete ? parseHostProbe(result.stdout) : null,
        agent
      },
      rules
    )
    this.publishCards(rules)
  }

  /**
   * Ask a batch of addresses about their agent, and remember what came back.
   *
   * Kept here rather than inline so `sweep` and `refreshOne` cannot drift on
   * what "detecting an agent" means - they used to, when a single-machine probe
   * and a sweep each built their own payload.
   */
  private async detect(
    targets: readonly AgentTarget[],
    rules: FleetRules
  ): Promise<Map<string, AgentInfo>> {
    return detectAgents(this.ctx, targets, rules, this.abortController?.signal)
  }

  private setStatus(patch: Partial<SweepStatus>): void {
    this.status = { ...this.status, ...patch, t: Date.now() }
    if (this.stopped) return
    this.ctx.emit('sweep', this.status)
  }

  /**
   * The wall, and nothing else - safe to call after a single machine changed.
   * Public because a caller that has already re-read a machine itself
   * (hostProbe) only needs the cards republished: going through `refreshOne`
   * would open a second SSH session to say what it already knows.
   */
  publishCards(rules: FleetRules = this.deps.rules()): HostsPayload {
    const payload = this.roster.cards(rules)
    this.latest = payload
    if (!this.stopped) this.ctx.emit('hosts', payload)
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
      ready: payload.counts.ready,
      noAgent: payload.counts.noAgent,
      unreachable: payload.counts.unreachable,
      running: payload.counts.instancesRunning,
      failed: payload.counts.instancesFailed
    }
    this.series.push(point)
    const cutoff = point.t - SERIES_MS
    while (this.series.length && this.series[0].t < cutoff) this.series.shift()
    if (this.stopped) return
    this.ctx.emit('series', point)
    this.ctx.addHistory({
      t: point.t,
      ready: point.ready,
      noAgent: point.noAgent,
      unreachable: point.unreachable,
      running: point.running,
      degraded: payload.counts.instancesDegraded,
      failed: point.failed,
      offline: payload.counts.hostsOffline
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
      this.roster.apply([], rules)
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
    this.abortController = new AbortController()
    const startedAt = Date.now()
    this.setStatus({
      state: 'running',
      done: 0,
      total: plan.targets.length,
      startedAt,
      finishedAt: null,
      message: `Sweeping ${plan.targets.length} addresses…`
    })

    let results
    try {
      results = await runFanout(this.ctx, plan.targets, HOST_PROBE_SCRIPT, rules, {
        onProgress: (done, total) => this.setStatus({ done, total }),
        cancelled: () => this.cancelRequested,
        signal: this.abortController.signal
      })
    } catch (err) {
      if (this.stopped) return
      this.setStatus({
        state: 'error',
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err)
      })
      return
    } finally {
      // Its job - being available for cancel() to abort - ends the moment
      // runFanout settles; a stray reference here would abort nothing but
      // could be mistaken for one still worth aborting.
      this.abortController = null
    }
    // runFanout can hold this for the whole sweep timeout; the module may
    // have been switched off, reloaded or disconnected in the meantime.
    if (this.stopped) return

    const byIp = new Map(plan.targets.map((target) => [target.ip, target]))
    const reachable: AgentTarget[] = []
    const partial = new Map<
      string,
      { reach: ReturnType<typeof classifyReach>; message: string; facts: ReturnType<typeof parseHostProbe> | null }
    >()
    for (const result of results) {
      const reach = classifyReach(result)
      const complete = reach === 'ok' && probeCompleted(result.stdout)
      partial.set(result.ip, {
        reach,
        message: reachMessage(reach, result),
        facts: complete ? parseHostProbe(result.stdout) : null
      })
      // A truncated answer - the connection dropped mid-script - is not a
      // machine that answered. Reading it as one would put a blank hostname
      // into the roster and claim the address was fine.
      if (complete) {
        reachable.push({
          ip: result.ip,
          port: rules.agentPort,
          token: this.roster.tokenFor(result.ip)
        })
      }
    }

    // Second pass, over HTTP, only for what answered. A cancelled sweep skips
    // it: the user asked for it to stop, and this is the expensive half.
    let agents = new Map<string, AgentInfo>()
    if (reachable.length && !this.cancelRequested && !this.stopped) {
      this.setStatus({ message: `Asking ${reachable.length} agents…` })
      try {
        agents = await this.detect(reachable, rules)
      } catch {
        // An agent pass that failed wholesale must not lose the SSH pass that
        // succeeded: the roster still learns which addresses are machines.
        agents = new Map()
      }
    }
    if (this.stopped) return

    const entries = results.map((result) => {
      const target = byIp.get(result.ip)
      const seen = partial.get(result.ip)
      return {
        ip: result.ip,
        cred: target?.cred ?? plan.targets[0].cred,
        reach: seen?.reach ?? 'error',
        reachMessage: seen?.message ?? 'no answer',
        facts: seen?.facts ?? null,
        agent: agents.get(result.ip) ?? null
      }
    })

    // A sweep cancelled early only covers a prefix of plan.targets - applying
    // it as a full sweep would read as "every address not yet reached this
    // round is no longer configured" and drop it from the wall, the Services
    // table and bulk targeting until the next full sweep completes.
    this.roster.apply(entries, rules, { partial: this.cancelRequested })
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
