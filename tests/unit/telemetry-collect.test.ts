import { describe, expect, it, vi } from 'vitest'
import { moduleHarness } from '../helpers/module-harness'
import { HostStore } from '../../service-fleet/main/store'
import { Roster, type SweepEntry } from '../../service-fleet/main/roster'
import { DEFAULT_RULES } from '../../service-fleet/main/rules'
import { TelemetryCollector, DAILY_SET, EVENTS_SET } from '../../service-fleet/main/telemetry/collect'
import type { TargetRule } from '../../service-fleet/main/config'

/**
 * Collecting is catching up, not sampling: each agent already has the rows and
 * keeps them for over a year. Everything worth testing here is about the
 * cursor - whether being switched off loses a week, and whether a failed write
 * loses rows it claimed to have kept.
 */

const RULE: TargetRule = {
  id: 't1',
  kind: 'cidr',
  value: '10.0.0.0/24',
  enabled: true,
  port: 22,
  username: 'root',
  auth: 'agent',
  sudo: 'none',
  excludes: [],
  createdAt: 0
}

function ready(ip: string): SweepEntry {
  return {
    ip,
    cred: RULE,
    reach: 'ok',
    reachMessage: 'ok',
    facts: null,
    agent: {
      state: 'ready',
      version: '1.0.0',
      message: 'answered',
      instances: [],
      net: null,
      checkedAt: Date.now()
    }
  }
}

/**
 * One framed answer, identified by the request's index.
 *
 * The index rather than the address is what lets one batch ask the same machine
 * two things - the daily rollups and the incidents - which is exactly what the
 * collector does, and what an address-keyed frame would have collapsed.
 */
function frame(index: number, ip: string, body: unknown, code = '0', status = '200'): string {
  return [
    '===BMAREQ===',
    String(index),
    '===BMAHOST===',
    ip,
    '===BMACODE===',
    code,
    '===BMASTATUS===',
    status,
    '===BMABODY===',
    typeof body === 'string' ? body : JSON.stringify(body),
    ''
  ].join('\n')
}

function setup(answers: () => string) {
  const harness = moduleHarness('service-fleet', async () => ({ code: 0, stdout: '', stderr: '' }), {
    recordSets: [DAILY_SET, EVENTS_SET]
  })
  // Every fan-out goes through one exec; the stub answers whatever the current
  // scenario wants, framed the way the jump host would.
  harness.exec.mockImplementation(async () => ({ code: 0, stdout: answers(), stderr: '' }))
  const roster = new Roster(new HostStore(harness.ctx))
  const collector = new TelemetryCollector(harness.ctx, roster)
  return { harness, roster, collector }
}

describe('collecting telemetry', () => {
  it('does nothing, and says so, when there are no agents', async () => {
    const { collector, harness } = setup(() => '')
    const summary = await collector.collect(DEFAULT_RULES)
    expect(summary.machines).toBe(0)
    expect(summary.message).toContain('No agents')
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('stores the rows an agent answered with, keyed by machine', async () => {
    const daily = { rows: [{ ts: 1000, scope: 'unit', template: 'honeygain', rx: 5, tx: 6 }] }
    const events = { rows: [{ ts: 1200, kind: 'link_down' }] }
    const { collector, roster, harness } = setup(
      () => frame(0, '10.0.0.1', daily) + frame(1, '10.0.0.1', events)
    )
    roster.apply([ready('10.0.0.1')], DEFAULT_RULES)
    roster.setToken('10.0.0.1', 'tok')

    const summary = await collector.collect(DEFAULT_RULES)
    expect(summary.dailyRows).toBe(1)
    expect(summary.eventRows).toBe(1)

    const stored = harness.records.get(DAILY_SET) ?? []
    expect(stored).toHaveLength(1)
    // `t` is the agent's own stamp, not the app's clock: re-stamping would
    // file a backfilled week under today.
    expect(stored[0].t).toBe(1000)
    expect(stored[0].key).toBe('10.0.0.1')
    expect((harness.records.get(EVENTS_SET) ?? [])[0].key).toBe('10.0.0.1')
  })

  it('advances the cursor to the newest row it kept', async () => {
    const daily = { rows: [{ ts: 1000, scope: 'unit' }, { ts: 3000, scope: 'unit' }] }
    const { collector, roster } = setup(() => frame(0, '10.0.0.1', daily) + frame(1, '10.0.0.1', { rows: [] }))
    roster.apply([ready('10.0.0.1')], DEFAULT_RULES)
    roster.setToken('10.0.0.1', 'tok')
    await collector.collect(DEFAULT_RULES)
    expect(roster.cursorFor('10.0.0.1')).toBe(3000)
  })

  it('asks for what came after the cursor, so nothing is fetched twice', async () => {
    const paths: string[] = []
    const harnessAnswers = (): string => frame(0, '10.0.0.1', { rows: [] }) + frame(1, '10.0.0.1', { rows: [] })
    const { collector, roster, harness } = setup(harnessAnswers)
    harness.exec.mockImplementation(async (_command: string, options?: { stdin?: string }) => {
      for (const line of (options?.stdin ?? '').split('\n')) {
        if (!line.startsWith('A\t')) continue
        paths.push(Buffer.from(line.split('\t')[5], 'base64').toString('utf8'))
      }
      return { code: 0, stdout: harnessAnswers(), stderr: '' }
    })
    roster.apply([ready('10.0.0.1')], DEFAULT_RULES)
    roster.setToken('10.0.0.1', 'tok')
    roster.setCursor('10.0.0.1', 5000)

    await collector.collect(DEFAULT_RULES)
    expect(paths.some((path) => path.includes('since=5001'))).toBe(true)
  })

  it('reaches back a bounded window on a first pull, not to the beginning of time', async () => {
    // An agent may hold four hundred days. Asking every machine for all of it
    // at once, on the first tick after installing this module, is not a good
    // first impression.
    const paths: string[] = []
    const { collector, roster, harness } = setup(() => '')
    harness.exec.mockImplementation(async (_command: string, options?: { stdin?: string }) => {
      for (const line of (options?.stdin ?? '').split('\n')) {
        if (!line.startsWith('A\t')) continue
        paths.push(Buffer.from(line.split('\t')[5], 'base64').toString('utf8'))
      }
      return { code: 0, stdout: frame(0, '10.0.0.1', { rows: [] }) + frame(1, '10.0.0.1', { rows: [] }), stderr: '' }
    })
    roster.apply([ready('10.0.0.1')], DEFAULT_RULES)
    roster.setToken('10.0.0.1', 'tok')

    const before = Date.now() - DEFAULT_RULES.telemetryBackfillDays * 86_400_000
    await collector.collect(DEFAULT_RULES)
    const since = Number(/since=(\d+)/.exec(paths[0] ?? '')?.[1] ?? '0')
    expect(since).toBeGreaterThanOrEqual(before - 5000)
    expect(since).toBeLessThanOrEqual(Date.now())
  })

  it('leaves the cursor alone when the rows could not be stored', async () => {
    // The whole point of the ordering: a cursor that moved past rows nothing
    // kept would leave a hole that is never noticed again.
    const daily = { rows: [{ ts: 9000, scope: 'unit' }] }
    const { collector, roster, harness } = setup(
      () => frame(0, '10.0.0.1', daily) + frame(1, '10.0.0.1', { rows: [] })
    )
    roster.apply([ready('10.0.0.1')], DEFAULT_RULES)
    roster.setToken('10.0.0.1', 'tok')
    vi.spyOn(harness.ctx, 'recordAppend').mockRejectedValue(new Error('over grant'))

    const summary = await collector.collect(DEFAULT_RULES)
    expect(summary.failed).toBe(1)
    expect(roster.cursorFor('10.0.0.1')).toBeNull()
  })

  it('counts an agent that did not answer without losing the ones that did', async () => {
    const daily = { rows: [{ ts: 1000, scope: 'unit' }] }
    const { collector, roster, harness } = setup(() => '')
    harness.exec.mockImplementation(async () => ({
      code: 0,
      // The first machine answers; the second's curl failed.
      stdout:
        frame(0, '10.0.0.1', daily) +
        frame(1, '10.0.0.1', { rows: [] }) +
        frame(2, '10.0.0.2', '', '7', '0') +
        frame(3, '10.0.0.2', '', '7', '0'),
      stderr: ''
    }))
    roster.apply([ready('10.0.0.1'), ready('10.0.0.2')], DEFAULT_RULES)
    roster.setToken('10.0.0.1', 'tok')
    roster.setToken('10.0.0.2', 'tok')

    const summary = await collector.collect(DEFAULT_RULES)
    expect(summary.machines).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.dailyRows).toBe(1)
    expect(roster.cursorFor('10.0.0.2')).toBeNull()
  })
})
