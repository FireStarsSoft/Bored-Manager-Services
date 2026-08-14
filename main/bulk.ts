/**
 * Acting on a whole fleet by describing it rather than ticking it: "restart
 * every failed docker.service on 10.0.0.*".
 *
 * The check resolves that description into an explicit list of machine/unit
 * pairs and freezes the list into the token's payload. That is the point, not an
 * optimisation: the user read a report naming twelve pairs, and a thirteenth
 * that appeared while they were reading the dialog is not what they agreed to.
 */
import {
  createCheckSession,
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { OkResult } from '@shared/types'
import type { Actions, HostSteps } from './actions'
import { resolveCredential, type FleetConfig } from './config'
import { matchesGlob } from './net'
import { unitStatus, type Roster } from './roster'
import type { FleetRules } from './rules'
import { DESTRUCTIVE_ACTIONS, isUnitAction, unitCommand, type UnitAction } from './units'

interface Pair {
  ip: string
  unit: string
}

interface BulkPlan {
  action: UnitAction
  pairs: Pair[]
}

const STATE_FILTERS = ['any', 'running', 'failed', 'stopped', 'missing'] as const
type StateFilter = (typeof STATE_FILTERS)[number]

function asStateFilter(value: unknown): StateFilter {
  return (STATE_FILTERS as readonly string[]).includes(String(value)) ? (String(value) as StateFilter) : 'any'
}

/** How many pairs a `pass` finding spells out before it starts counting instead. */
const SAMPLE = 12

export class BulkActions {
  private session = createCheckSession<BulkPlan>()

  constructor(
    private roster: Roster,
    private actions: Actions,
    private deps: { config: () => FleetConfig; rules: () => FleetRules }
  ) {}

  clear(): void {
    this.session.clear()
  }

  check(raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const action = values['action']
    if (!isUnitAction(action)) return failedCheck('Pick an action', 'Choose what to do with the matching services.')
    const hostGlob = String(values['hosts'] ?? '')
    const unitGlob = String(values['units'] ?? '')
    const onlyWatched = values['onlyWatched'] === true
    const state = asStateFilter(values['state'])
    const rules = this.deps.rules()
    const findings: ModuleCheckFinding[] = []

    const pairs: Pair[] = []
    const skipped: string[] = []
    for (const live of this.roster.controllable(this.deps.config().targets)) {
      if (!matchesGlob(hostGlob, [live.ip, live.cred.label])) continue
      const problem = this.actions.controlProblem(live.ip)
      if (problem) {
        skipped.push(problem)
        continue
      }
      for (const { state: unit, watched, severity } of this.roster.unitsFor(live.ip)) {
        if (onlyWatched && !watched) continue
        if (!matchesGlob(unitGlob, [unit.unit])) continue
        const health = unitStatus(unit, watched, severity === 'critical')
        if (state === 'running' && unit.active !== 'active') continue
        if (state === 'failed' && health !== 'bad') continue
        if (state === 'stopped' && unit.active === 'active') continue
        if (state === 'missing' && unit.load !== 'not-found') continue
        pairs.push({ ip: live.ip, unit: unit.unit })
      }
    }

    if (pairs.length === 0) {
      return failedCheck(
        'Nothing matches',
        'No machine and service in the roster matches that description. Widen the filters, or sweep again if the roster looks stale.'
      )
    }

    const machines = new Set(pairs.map((pair) => pair.ip)).size
    findings.push({
      level: 'pass',
      label: `Will run ${action} on ${pairs.length} service${pairs.length === 1 ? '' : 's'} across ${machines} machine${machines === 1 ? '' : 's'}`,
      detail: pairs
        .slice(0, SAMPLE)
        .map((pair) => `${pair.ip} ${pair.unit}`)
        .join(', ')
        .concat(pairs.length > SAMPLE ? `, and ${pairs.length - SAMPLE} more` : '')
    })

    if (DESTRUCTIVE_ACTIONS.includes(action)) {
      findings.push({
        level: 'warning',
        label: `${action} takes these services away`,
        detail:
          action === 'stop'
            ? 'They will not come back until something starts them, and anything depending on them stops too.'
            : action === 'disable'
              ? 'They will not start at the next boot.'
              : 'A masked unit cannot even be started by hand until it is unmasked.'
      })
    }
    if (pairs.length > rules.bulkWarnAt) {
      findings.push({
        level: 'warning',
        label: `That is more than the ${rules.bulkWarnAt} this install warns at`,
        detail: 'Raise or lower the threshold in Rules if this is normal for your fleet.'
      })
    }
    if (skipped.length) {
      findings.push({
        level: 'info',
        label: `${skipped.length} machine${skipped.length === 1 ? '' : 's'} left out`,
        detail: [...new Set(skipped)].slice(0, 4).join('; ')
      })
    }
    findings.push({
      level: 'info',
      label: 'Runs as a job',
      detail: `Machines are contacted ${rules.maxParallel} at a time; the Jobs page shows each one and can cancel the rest.`
    })

    const ok = !hasBlockingFinding(findings)
    return ok ? { ok, token: this.session.issue(values, { action, pairs }), findings } : { ok, findings }
  }

  apply(raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const { action, pairs } = taken.payload
    const config = this.deps.config()
    const byIp = new Map<string, HostSteps>()
    for (const pair of pairs) {
      const cred = resolveCredential(pair.ip, config.targets)
      if (!cred) continue
      const entry = byIp.get(pair.ip) ?? { ip: pair.ip, cred, steps: [] }
      entry.steps.push({ name: `${pair.unit} ${action}`, command: unitCommand(action, pair.unit) })
      byIp.set(pair.ip, entry)
    }
    const work = [...byIp.values()]
    if (work.length === 0) {
      return { ok: false, error: 'none of the machines in that plan are covered by an address rule any more' }
    }
    const job = this.actions.startJob(
      `bulk-${action}`,
      `${action} ${pairs.length} service${pairs.length === 1 ? '' : 's'} on ${work.length} machine${work.length === 1 ? '' : 's'}`,
      work
    )
    return { ok: true, data: job.id }
  }
}
