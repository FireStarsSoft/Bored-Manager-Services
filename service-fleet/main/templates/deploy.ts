/**
 * Deploying a template to several machines, and acting on several instances.
 *
 * Both are jobs, for the same reason the agent installer is: they act on a list,
 * and one machine failing must not hide the nineteen that worked. The job's item
 * list is the report.
 *
 * The check step is where a deploy earns its keep. It resolves the template,
 * fills in defaults, refuses on a missing required value, and **freezes the
 * machine list and the values into the token** - so what is applied is exactly
 * what the report was read for, even if the fleet changed in between.
 */
import { createCheckSession, type ModuleCheckFinding, type ModuleCheckReport } from '@shared/check'
import type { OkResult } from '@shared/types'
import { INSTANCE_ACTIONS, type InstanceAction, type InstanceActions } from '../actions'
import type { FleetConfig } from '../config'
import type { FleetJobs } from '../jobs'
import type { JumpCapabilities } from '../probe'
import type { Roster } from '../roster'
import type { FleetRules } from '../rules'
import type { Sweeper } from '../sweep'
import { findTemplate, type Library, type LibraryEntry } from './library'

interface Deps {
  config: () => FleetConfig
  rules: () => FleetRules
  capabilities: () => JumpCapabilities
}

interface DeployPlan {
  templateId: string
  ips: string[]
  values: Record<string, string>
}

function text(values: Record<string, unknown>, key: string): string {
  const raw = values[key]
  return typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw)
}

function list(values: Record<string, unknown>, key: string): string[] {
  const raw = values[key]
  if (Array.isArray(raw)) return raw.map((entry) => String(entry ?? '')).filter(Boolean)
  const single = text(values, key)
  return single ? single.split(/[\s,]+/).filter(Boolean) : []
}

export class Deployer {
  private session = createCheckSession<DeployPlan>()

  constructor(
    private roster: Roster,
    private jobs: FleetJobs,
    private actions: InstanceActions,
    private sweeper: Sweeper,
    private deps: Deps,
    private library: () => Library
  ) {}

  clear(): void {
    this.session.clear()
  }

  check(raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const findings: ModuleCheckFinding[] = []

    const capabilities = this.deps.capabilities()
    if (capabilities.problem) {
      return { ok: false, findings: [{ level: 'error', label: capabilities.problem }] }
    }

    const templateId = text(values, 'template')
    if (!templateId) {
      return { ok: false, findings: [{ level: 'error', label: 'no template was chosen' }] }
    }
    const entry = findTemplate(this.library(), templateId)
    if (!entry) {
      return { ok: false, findings: [{ level: 'error', label: `no template "${templateId}" in the library` }] }
    }

    const ips = list(values, 'machines')
    if (!ips.length) {
      return { ok: false, findings: [{ level: 'error', label: 'no machines were chosen' }] }
    }

    // The form carries one input per template field, named `field_<id>` so a
    // field called `template` or `machines` cannot collide with the form's own.
    const filled: Record<string, string> = {}
    for (const field of entry.template.fields) {
      const supplied = text(values, `field_${field.id}`)
      const resolved = supplied || field.default || ''
      if (field.required && !resolved) {
        findings.push({ level: 'error', label: `${field.label} is required` })
        continue
      }
      if (resolved) filled[field.id] = resolved
    }

    const usable: string[] = []
    for (const ip of ips) {
      const live = this.roster.liveFor(ip)
      if (!live) {
        findings.push({ level: 'error', label: `${ip} is not in the roster` })
        continue
      }
      if (!this.roster.tokenFor(ip)) {
        findings.push({
          level: 'error',
          label: `${ip} has no agent token`,
          detail: 'Install the agent on it first, from Machines.'
        })
        continue
      }
      const existing = live.agent?.instances.find((instance) => instance.id === templateId)
      if (existing) {
        findings.push({
          level: 'info',
          label: `${ip} already runs ${templateId}`,
          detail: 'It will be reinstalled with these values. The container is replaced, not duplicated.'
        })
      }
      usable.push(ip)
    }

    if (!usable.length || findings.some((finding) => finding.level === 'error')) {
      return {
        ok: false,
        findings: findings.length ? findings : [{ level: 'error', label: 'nothing to deploy to' }]
      }
    }

    if (entry.template.privileged) {
      findings.push({
        level: 'warning',
        label: 'This template runs a shell as root',
        detail:
          'It declares "privileged": true, which lets it use the `script` opcode. Only deploy it if you wrote it or trust whoever did.'
      })
    }

    // The one warning these platforms actually need. Their terms forbid several
    // devices behind one connection, and the fleet is the only thing that can
    // see it coming.
    const byPublicIp = new Map<string, string[]>()
    for (const ip of usable) {
      const publicIp = this.roster.liveFor(ip)?.agent?.net?.publicIp
      if (!publicIp) continue
      const bucket = byPublicIp.get(publicIp) ?? []
      bucket.push(ip)
      byPublicIp.set(publicIp, bucket)
    }
    for (const [publicIp, machines] of byPublicIp) {
      if (machines.length < 2) continue
      findings.push({
        level: 'warning',
        label: `${machines.length} of these machines share the public address ${publicIp}`,
        detail: `${machines.join(', ')} - most bandwidth-sharing services forbid several devices on one connection, and running this on all of them may get the account suspended.`
      })
    }

    const secretCount = entry.template.fields.filter((field) => field.secret && filled[field.id]).length
    if (secretCount) {
      findings.push({
        level: 'warning',
        label: `${secretCount} secret value(s) will be stored on each machine`,
        detail:
          'The agent keeps them at /var/lib/boredagent/credentials.json, mode 0640, unencrypted. They are never returned by its API and are masked in its logs.'
      })
    }

    findings.push({
      level: 'pass',
      label: `Deploy ${entry.template.displayName} to ${usable.length} machine(s)`,
      detail: `Units: ${entry.template.units.join(', ')}.`
    })

    const token = this.session.issue(values, { templateId, ips: usable, values: filled })
    return { ok: true, token, findings }
  }

  apply(raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const taken = this.session.take(typeof payload.token === 'string' ? payload.token : '', payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const plan = taken.payload
    const entry = findTemplate(this.library(), plan.templateId)
    if (!entry) return { ok: false, error: `the template "${plan.templateId}" is no longer in the library` }
    const rules = this.deps.rules()

    this.jobs.start({
      kind: 'deploy',
      label: `Deploy ${entry.template.displayName} to ${plan.ips.length} machine(s)`,
      names: plan.ips,
      run: async (report) => {
        const outcomes = await this.actions.deploy(plan.ips, entry, plan.values, rules)
        for (const outcome of outcomes) report(outcome.ip, outcome.ok, outcome.message)
        await this.sweeper.run().catch(() => undefined)
      }
    })
    return { ok: true, data: `Deploying to ${plan.ips.length} machine(s).` }
  }

  /**
   * A ticked-rows action from the instances table.
   *
   * Not a check/apply pair: the rows are already visible, the verb is on the
   * button, and a confirm dialog on the destructive ones is enough. A check
   * step here would put a report in front of the user that said no more than
   * the toolbar already did.
   */
  bulkAction(keysRaw: unknown, actionRaw: unknown): OkResult {
    const keys = Array.isArray(keysRaw) ? keysRaw.map((key) => String(key ?? '')).filter(Boolean) : []
    const action = String(actionRaw ?? '') as InstanceAction
    if (!keys.length) return { ok: false, error: 'nothing was selected' }
    if (!INSTANCE_ACTIONS.includes(action)) return { ok: false, error: `"${action}" is not an action` }
    const rules = this.deps.rules()

    this.jobs.start({
      kind: `instance-${action}`,
      label: `${action} ${keys.length} instance(s)`,
      names: keys,
      run: async (report) => {
        const outcomes = await this.actions.run(keys, action, rules)
        for (const outcome of outcomes) {
          report(`${outcome.ip}|${outcome.template}`, outcome.ok, outcome.message)
        }
        await this.sweeper.run().catch(() => undefined)
      }
    })
    return { ok: true, data: `${action} started on ${keys.length} instance(s).` }
  }
}

/** Re-exported so index.ts does not need a second import for one type. */
export type { LibraryEntry }
