/**
 * Changing something, on one machine or on many. Everything here ends up in the
 * same place - a privileged payload piped to `sh -s` on each target - and the
 * only real difference between one machine and forty is whether the call waits
 * for the answer or hands the work to a job.
 *
 * Nothing in this file builds a command by concatenating user input: a unit name
 * is checked against `isValidUnit` and then quoted with `shQuote`, and the
 * action is one of a fixed list.
 */
import type { ModuleContext, ModuleStreamHandle } from '@shared/modules'
import { shQuote } from '@shared/shell'
import type { OkResult } from '@shared/types'
import { resolveCredential, type FleetConfig, type TargetRule } from './config'
import {
  classifyReach,
  reachMessage,
  runFanout,
  sshStreamCommand,
  type FanoutTarget
} from './fanout'
import type { FleetJobs } from './jobs'
import type { Roster } from './roster'
import type { FleetRules } from './rules'
import type { Sweeper } from './sweep'
import type { FleetJob } from './store'
import {
  actionPayload,
  canControl,
  isUnitAction,
  isValidUnit,
  parseSteps,
  unitCommand,
  type Step,
  type UnitAction
} from './units'

/** What one machine is asked to do in a job. */
export interface HostSteps {
  ip: string
  cred: TargetRule
  steps: Step[]
}

/** Past this many machines, one full sweep is cheaper than re-reading each one. */
const REFRESH_ONE_BY_ONE_UP_TO = 5

export interface PairKey {
  ip: string
  unit: string
}

/** Rows on the Services page are keyed `<ip>|<unit>`, which is what a bulk action gets. */
export function parsePairKey(raw: unknown): PairKey | null {
  if (typeof raw !== 'string') return null
  const bar = raw.indexOf('|')
  if (bar <= 0) return null
  const ip = raw.slice(0, bar).trim()
  const unit = raw.slice(bar + 1).trim()
  if (!ip || !isValidUnit(unit)) return null
  return { ip, unit }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class Actions {
  private streams = new Map<string, ModuleStreamHandle>()

  constructor(
    private ctx: ModuleContext,
    private roster: Roster,
    private jobs: FleetJobs,
    private sweeper: Sweeper,
    private deps: { config: () => FleetConfig; rules: () => FleetRules }
  ) {}

  /** Kill every log tail. Called from the module's dispose, before ctx is revoked. */
  dispose(): void {
    for (const handle of this.streams.values()) {
      try {
        handle.kill()
      } catch {
        /* already gone */
      }
    }
    this.streams.clear()
  }

  /**
   * Whether this address can be told to do anything, and why not when it cannot.
   * Checked before every action so the refusal explains itself instead of coming
   * back as `sudo: a password is required` from forty machines at once.
   */
  controlProblem(ip: string): string | null {
    const config = this.deps.config()
    const cred = resolveCredential(ip, config.targets)
    if (!cred) return `${ip} is not covered by any address rule`
    const live = this.roster.liveFor(ip)
    if (!live) return `${ip} has not been swept yet`
    if (live.reach !== 'ok') return `${ip} is not reachable: ${live.reachMessage}`
    if (!live.facts?.systemd) return `${ip} has no systemd`
    if (!canControl(live.facts, cred.sudo)) {
      return cred.sudo === 'none'
        ? `${ip} is set to use no sudo and the account is not root`
        : `${ip} needs a sudo password and none is set for it`
    }
    return null
  }

  private targetFor(ip: string, steps: Step[]): FanoutTarget | null {
    const cred = resolveCredential(ip, this.deps.config().targets)
    if (!cred) return null
    return { ip, cred, payload: actionPayload(steps, cred) }
  }

  /** One machine, one or more commands, waited for - the row actions use this. */
  async runNow(ip: string, steps: Step[]): Promise<OkResult> {
    const problem = this.controlProblem(ip)
    if (problem) return { ok: false, error: problem }
    const target = this.targetFor(ip, steps)
    if (!target) return { ok: false, error: `${ip} is not covered by any address rule` }
    const rules = this.deps.rules()
    let results
    try {
      results = await runFanout(this.ctx, [target], '', rules)
    } catch (err) {
      return { ok: false, error: message(err) }
    }
    const result = results[0]
    if (!result) return { ok: false, error: 'the connected machine returned nothing' }
    const reach = classifyReach(result)
    if (reach !== 'ok') return { ok: false, error: reachMessage(reach, result) }
    const done = parseSteps(result.stdout)
    const failed = done.filter((step) => step.rc !== 0)
    // The state on that machine has just changed, so the pages should not have
    // to wait for the next sweep to say so.
    void this.sweeper.refreshOne(ip).catch(() => undefined)
    if (done.length === 0) return { ok: false, error: 'the machine did not report back on the action' }
    if (failed.length > 0) {
      return { ok: false, error: failed.map((step) => `${step.name}: ${step.say || `exit ${step.rc}`}`).join('; ') }
    }
    return { ok: true, data: done.map((step) => step.say).filter((say) => say).join('\n') || undefined }
  }

  /**
   * Many machines, handed to a job so the call can return. Each machine gets its
   * own payload, because each may need its own sudo password.
   */
  startJob(kind: string, label: string, work: readonly HostSteps[]): FleetJob {
    const rules = this.deps.rules()
    return this.jobs.start({
      kind,
      label,
      names: work.map((entry) => entry.ip),
      run: async (report, cancelled) => {
        const targets: FanoutTarget[] = work.map((entry) => ({
          ip: entry.ip,
          cred: entry.cred,
          payload: actionPayload(entry.steps, entry.cred)
        }))
        const results = await runFanout(this.ctx, targets, '', rules, { cancelled })
        for (const result of results) {
          const reach = classifyReach(result)
          if (reach !== 'ok') {
            report(result.ip, false, reachMessage(reach, result))
            continue
          }
          const done = parseSteps(result.stdout)
          const failed = done.filter((step) => step.rc !== 0)
          if (done.length === 0) report(result.ip, false, 'the machine did not report back on the action')
          else if (failed.length === 0) report(result.ip, true, done.map((step) => step.name).join(', '))
          else {
            report(
              result.ip,
              false,
              failed.map((step) => `${step.name}: ${step.say || `exit ${step.rc}`}`).join('; ')
            )
          }
        }
        if (cancelled()) return
        if (work.length <= REFRESH_ONE_BY_ONE_UP_TO) {
          for (const entry of work) await this.sweeper.refreshOne(entry.ip).catch(() => undefined)
        } else {
          await this.sweeper.run().catch(() => undefined)
        }
      }
    })
  }

  // ---------- the methods the UI calls ----------

  async unitAction(ipRaw: unknown, unitRaw: unknown, actionRaw: unknown): Promise<OkResult> {
    const ip = String(ipRaw ?? '')
    const unit = String(unitRaw ?? '')
    if (!isValidUnit(unit)) return { ok: false, error: `"${unit}" is not a unit name` }
    if (!isUnitAction(actionRaw)) return { ok: false, error: `"${String(actionRaw)}" is not an action` }
    return this.runNow(ip, [{ name: `${unit} ${actionRaw}`, command: unitCommand(actionRaw, unit) }])
  }

  /** The ticked rows on the Services page: `method(selectedRowKeys[], action)`. */
  bulkUnitAction(keysRaw: unknown, actionRaw: unknown): OkResult {
    if (!isUnitAction(actionRaw)) return { ok: false, error: `"${String(actionRaw)}" is not an action` }
    const action: UnitAction = actionRaw
    const keys = Array.isArray(keysRaw) ? keysRaw : []
    if (keys.length === 0) return { ok: false, error: 'nothing was selected' }
    const config = this.deps.config()
    const byIp = new Map<string, HostSteps>()
    const refused: string[] = []
    for (const raw of keys) {
      const pair = parsePairKey(raw)
      if (!pair) continue
      const problem = this.controlProblem(pair.ip)
      if (problem) {
        if (!refused.includes(problem)) refused.push(problem)
        continue
      }
      const cred = resolveCredential(pair.ip, config.targets)
      if (!cred) continue
      const entry = byIp.get(pair.ip) ?? { ip: pair.ip, cred, steps: [] }
      entry.steps.push({ name: `${pair.unit} ${action}`, command: unitCommand(action, pair.unit) })
      byIp.set(pair.ip, entry)
    }
    const work = [...byIp.values()]
    if (work.length === 0) {
      return { ok: false, error: refused[0] ?? 'none of the selected rows can be acted on' }
    }
    const units = work.reduce((sum, entry) => sum + entry.steps.length, 0)
    const job = this.startJob(
      `unit-${action}`,
      `${action} ${units} service${units === 1 ? '' : 's'} on ${work.length} machine${work.length === 1 ? '' : 's'}`,
      work
    )
    return {
      ok: true,
      data: refused.length ? `${job.id} (skipped: ${refused[0]})` : job.id
    }
  }

  /** Only reboot, and only behind a confirm in the spec. */
  async hostAction(ipRaw: unknown, actionRaw: unknown): Promise<OkResult> {
    if (actionRaw !== 'reboot') return { ok: false, error: `"${String(actionRaw)}" is not a machine action` }
    const ip = String(ipRaw ?? '')
    const result = await this.runNow(ip, [{ name: 'reboot', command: 'systemctl reboot' }])
    // A machine that reboots often drops the connection before it can answer,
    // which is success here rather than failure.
    if (!result.ok && /closed|reset by peer|broken pipe|exit 255/i.test(result.error ?? '')) {
      return { ok: true, data: 'reboot requested; the machine dropped the connection' }
    }
    return result
  }

  /** A live read of one unit on one machine, for the drawer. */
  async unitInspect(ipRaw: unknown, unitRaw: unknown): Promise<Record<string, unknown> | null> {
    const ip = String(ipRaw ?? '')
    const unit = String(unitRaw ?? '')
    if (!isValidUnit(unit)) return null
    const cred = resolveCredential(ip, this.deps.config().targets)
    if (!cred) return null
    const props = [
      'Id',
      'Description',
      'LoadState',
      'ActiveState',
      'SubState',
      'UnitFileState',
      'MainPID',
      'NRestarts',
      'Restart',
      'FragmentPath',
      'ActiveEnterTimestamp',
      'MemoryCurrent'
    ]
    const payload = `systemctl show --no-pager ${props.map((p) => `-p ${p}`).join(' ')} ${shQuote(unit)} 2>/dev/null\n`
    const results = await runFanout(this.ctx, [{ ip, cred }], payload, this.deps.rules())
    const result = results[0]
    if (!result) return null
    const reach = classifyReach(result)
    if (reach !== 'ok') return { unit, error: reachMessage(reach, result) }
    const out: Record<string, unknown> = { ip, unit }
    for (const line of result.stdout.split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (!props.includes(key)) continue
      const asNumber = Number(value)
      out[key] = value !== '' && Number.isFinite(asNumber) && /^\d+$/.test(value) ? asNumber : value
    }
    return out
  }

  /**
   * Tail `journalctl -f` from one machine into the `log` event.
   *
   * `ctx.stream` has no stdin, so a password cannot be handed to ssh safely. For
   * a password-authenticated address this first runs a one-line fan-out, which
   * does have stdin and leaves a multiplexed connection behind; the tail then
   * rides that socket and needs no credentials at all.
   */
  async logsStart(idRaw: unknown): Promise<OkResult> {
    const pair = parsePairKey(idRaw)
    if (!pair) return { ok: false, error: 'that row does not name a machine and a unit' }
    const id = `${pair.ip}|${pair.unit}`
    const cred = resolveCredential(pair.ip, this.deps.config().targets)
    if (!cred) return { ok: false, error: `${pair.ip} is not covered by any address rule` }
    const rules = this.deps.rules()
    if (cred.auth === 'password') {
      if (rules.controlPersistSec <= 0) {
        return {
          ok: false,
          error:
            'Following a log over a password login needs connection sharing. Set "Keep SSH connections warm" above 0 in this module\'s rules, or use an SSH key for this address.'
        }
      }
      const opened = await runFanout(this.ctx, [{ ip: pair.ip, cred }], 'exit 0\n', rules)
      const reach = classifyReach(opened[0] ?? { ip: pair.ip, rc: 255, stdout: '', stderr: '' })
      if (reach !== 'ok') {
        return { ok: false, error: reachMessage(reach, opened[0] ?? { ip: pair.ip, rc: 255, stdout: '', stderr: '' }) }
      }
    }
    this.logsStop(id)
    const remote = `journalctl --no-pager -n 200 -f -u ${shQuote(pair.unit)} 2>&1`
    try {
      const handle = await this.ctx.stream(sshStreamCommand({ ip: pair.ip, cred }, rules, remote))
      this.streams.set(id, handle)
      handle.onData((data) => this.ctx.emit('log', { id, data }))
      handle.onExit((code) => {
        this.streams.delete(id)
        this.ctx.emit('log', { id, data: `\n[journalctl stopped${code == null ? '' : `, exit ${code}`}]\n` })
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: message(err) }
    }
  }

  logsStop(idRaw: unknown): OkResult {
    const id = typeof idRaw === 'string' ? idRaw : ''
    const handle = this.streams.get(id)
    if (!handle) return { ok: true }
    this.streams.delete(id)
    try {
      handle.kill()
    } catch {
      /* already gone */
    }
    return { ok: true }
  }
}
