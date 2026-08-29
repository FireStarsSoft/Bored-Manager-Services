/**
 * Pulling each agent's daily rows and incidents into the app's record store.
 *
 * The division of labour is the whole design. An agent samples every minute,
 * folds each day into one row per unit, and keeps well over a year of them.
 * This module asks, on a slow timer, for whatever came after the cursor it
 * remembers per machine - so being switched off for a week costs nothing: the
 * next pull fetches the week.
 *
 * That is why the cursor is advanced **only after a successful append**. If it
 * moved first, a failed write would leave the cursor past rows nothing kept and
 * the gap would never be noticed - which is also why `ctx.recordAppend` rejects
 * rather than silently doing nothing after the module stops.
 */
import type { ModuleContext, ModuleRecord } from '@shared/modules'
import { classifyAgent, runAgentFanout, type AgentRequest } from '../agentfan'
import type { Roster } from '../roster'
import type { FleetRules } from '../rules'

/** Declared in module.json; a write to anything else is refused by the host. */
export const DAILY_SET = 'daily'
export const EVENTS_SET = 'events'

const DAY_MS = 86_400_000

/** Rows one machine may contribute in one pull, so a first pull cannot flood. */
const MAX_ROWS_PER_MACHINE = 2000

export interface CollectSummary {
  t: number
  machines: number
  dailyRows: number
  eventRows: number
  failed: number
  message: string
}

function asRows(json: unknown): Array<Record<string, unknown>> {
  const root = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : null
  const rows = root?.['rows']
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && typeof (row as { ts?: unknown }).ts === 'number'
  )
}

/**
 * Turn an agent row into a record.
 *
 * `key` is the machine, so a query can ask for one agent's history without
 * reading the fleet's. `t` is passed through untouched: the agent stamped it in
 * epoch milliseconds, and re-stamping it with the app's clock would file a
 * backfilled week under today.
 */
function toRecord(ip: string, row: Record<string, unknown>): ModuleRecord {
  return { ...row, t: row['ts'] as number, key: ip }
}

export class TelemetryCollector {
  private last: CollectSummary = {
    t: 0,
    machines: 0,
    dailyRows: 0,
    eventRows: 0,
    failed: 0,
    message: 'Not collected yet.'
  }

  constructor(
    private ctx: ModuleContext,
    private roster: Roster
  ) {}

  summary(): CollectSummary {
    return this.last
  }

  reset(): void {
    this.last = { ...this.last, t: 0, message: 'Not collected yet.' }
  }

  /**
   * One pass over every agent that can answer.
   *
   * Two requests per machine, both in one fan-out: the daily rollups and the
   * incident log. They are pulled together because a day's rows and the
   * incidents inside that day are read together on the Reports page, and
   * splitting them into two passes would let one succeed and the other not.
   */
  async collect(rules: FleetRules, signal?: AbortSignal): Promise<CollectSummary> {
    const agents = this.roster.agents()
    if (!agents.length) {
      this.last = {
        t: Date.now(),
        machines: 0,
        dailyRows: 0,
        eventRows: 0,
        failed: 0,
        message: 'No agents to collect from yet.'
      }
      return this.last
    }

    const floor = Date.now() - rules.telemetryBackfillDays * DAY_MS
    const requests: AgentRequest[] = []
    for (const live of agents) {
      const cursor = this.roster.cursorFor(live.ip)
      // A machine with no cursor is a first pull: reach back the configured
      // number of days rather than asking for everything the agent has, which
      // could be four hundred days for every machine at once.
      const since = cursor == null ? floor : cursor + 1
      const token = this.roster.tokenFor(live.ip)
      // The agent port, not the machine's SSH port - the two are unrelated.
      const base = { ip: live.ip, port: rules.agentPort, token }
      requests.push({
        ...base,
        method: 'GET',
        path: `/v1/stats/daily?since=${since}&limit=${MAX_ROWS_PER_MACHINE}`
      })
      requests.push({
        ...base,
        method: 'GET',
        path: `/v1/stats/events?since=${since}&limit=${MAX_ROWS_PER_MACHINE}`
      })
    }

    const answers = await runAgentFanout(this.ctx, requests, rules, { signal })

    let dailyRows = 0
    let eventRows = 0
    let failed = 0
    for (let i = 0; i < agents.length; i++) {
      const ip = agents[i].ip
      const dailyResponse = answers[i * 2]
      const eventsResponse = answers[i * 2 + 1]
      if (!dailyResponse || classifyAgent(dailyResponse) !== 'ok' || dailyResponse.status !== 200) {
        failed++
        continue
      }

      const daily = asRows(dailyResponse.json)
      const events =
        eventsResponse && classifyAgent(eventsResponse) === 'ok' && eventsResponse.status === 200
          ? asRows(eventsResponse.json)
          : []

      try {
        if (daily.length) {
          await this.ctx.recordAppend(DAILY_SET, daily.map((row) => toRecord(ip, row)))
          dailyRows += daily.length
        }
        if (events.length) {
          await this.ctx.recordAppend(EVENTS_SET, events.map((row) => toRecord(ip, row)))
          eventRows += events.length
        }
      } catch (err) {
        // The append failed - over grant, or the module stopped mid-pull. The
        // cursor stays where it was, so the next pass asks for the same rows
        // again rather than skipping them.
        failed++
        this.ctx.log(`service-fleet: telemetry for ${ip} could not be stored: ${String(err)}`)
        continue
      }

      const newest = Math.max(
        ...daily.map((row) => row['ts'] as number),
        ...events.map((row) => row['ts'] as number),
        Number.NEGATIVE_INFINITY
      )
      if (Number.isFinite(newest)) this.roster.setCursor(ip, newest)
    }

    this.last = {
      t: Date.now(),
      machines: agents.length,
      dailyRows,
      eventRows,
      failed,
      message: failed
        ? `${agents.length - failed} of ${agents.length} agents answered; ${dailyRows} daily rows and ${eventRows} incidents kept.`
        : `${dailyRows} daily rows and ${eventRows} incidents from ${agents.length} agent(s).`
    }
    return this.last
  }
}
