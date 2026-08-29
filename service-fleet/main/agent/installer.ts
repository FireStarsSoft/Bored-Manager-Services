/**
 * The check-then-apply pair behind "Install agent" and "Remove agent".
 *
 * Both are jobs rather than single calls, because both act on a list of
 * machines and one of them can fail while the rest succeed. The job's item list
 * is the report: one row per machine, with the installer's own words when it
 * refused.
 *
 * The token is the reason `apply` is more than a fan-out. `agent-install.sh`
 * prints it once, in its result block, and this is the only moment it is ever
 * visible - so the outcome is parsed for it and it is written to the roster
 * before the job is marked done. A machine whose token is not captured is left
 * in `untrusted`, which the Machines page can act on, rather than silently
 * being unusable.
 */
import { createCheckSession, type ModuleCheckFinding, type ModuleCheckReport } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { resolveCredential, type FleetConfig, type TargetRule } from '../config'
import type { FanoutTarget } from '../fanout'
import { runFanout } from '../fanout'
import type { FleetJobs } from '../jobs'
import type { JumpCapabilities } from '../probe'
import type { Roster } from '../roster'
import type { FleetRules } from '../rules'
import type { Sweeper } from '../sweep'
import { AGENT_SHA256, AGENT_VERSION, agentPinned, agentTarballUrl } from './manifest'
import { installBlocked, installPayload, readInstall, uninstallPayload } from './lifecycle'

interface Deps {
  config: () => FleetConfig
  rules: () => FleetRules
  capabilities: () => JumpCapabilities
}

interface InstallPlan {
  ips: string[]
  url: string
  sha256: string
  version: string
}

interface UninstallPlan {
  ips: string[]
  purge: boolean
}

/**
 * The sweep's limits are wrong for an install.
 *
 * A sweep asks a question and expects an answer in seconds; an install
 * downloads a tarball, runs apt and builds a virtualenv, which on a slow line
 * is minutes. Reusing the sweep's timeouts would cut every install off partway
 * and report a machine as timed out while it was still installing - the worst
 * possible outcome, because it leaves the machine half-configured and the user
 * told nothing useful.
 */
function longRunning(rules: FleetRules): FleetRules {
  return {
    ...rules,
    perHostTimeoutSec: Math.max(rules.perHostTimeoutSec, 900),
    sweepTimeoutSec: Math.max(rules.sweepTimeoutSec, 900)
  }
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

export class AgentInstaller {
  private install = createCheckSession<InstallPlan>()
  private remove = createCheckSession<UninstallPlan>()

  constructor(
    private ctx: ModuleContext,
    private roster: Roster,
    private jobs: FleetJobs,
    private sweeper: Sweeper,
    private deps: Deps
  ) {}

  clear(): void {
    this.install.clear()
    this.remove.clear()
  }

  /** What installing on these machines would do, before it is done. */
  check(raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const findings: ModuleCheckFinding[] = []
    const rules = this.deps.rules()
    const config = this.deps.config()

    const capabilities = this.deps.capabilities()
    if (capabilities.problem) {
      return { ok: false, findings: [{ level: 'error', label: capabilities.problem }] }
    }

    const ips = list(values, 'machines')
    if (!ips.length) {
      return { ok: false, findings: [{ level: 'error', label: 'no machines were chosen' }] }
    }

    // A version and a hash may be typed in to install something other than the
    // pinned release - which is also the only way to install at all while the
    // pin is empty.
    const version = text(values, 'version') || AGENT_VERSION
    const url = text(values, 'url') || agentTarballUrl(version)
    const sha256 = (text(values, 'sha256') || AGENT_SHA256).toLowerCase()

    const blocked = installBlocked(Boolean(text(values, 'sha256')))
    if (blocked) findings.push({ level: 'error', label: blocked })
    if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) {
      findings.push({ level: 'error', label: 'the sha256 is not 64 hexadecimal characters' })
    }

    const usable: string[] = []
    for (const ip of ips) {
      const cred = resolveCredential(ip, config.targets)
      if (!cred) {
        findings.push({ level: 'error', label: `${ip} is not covered by any address rule` })
        continue
      }
      const live = this.roster.liveFor(ip)
      if (live && live.reach !== 'ok') {
        findings.push({ level: 'error', label: `${ip} did not answer over SSH (${live.reachMessage})` })
        continue
      }
      if (cred.sudo === 'none' && cred.username !== 'root') {
        // The installer needs root. Saying so now is much better than a job
        // where every row fails with "sudo: a password is required".
        findings.push({
          level: 'error',
          label: `${ip} logs in as ${cred.username} with no sudo configured`,
          detail: 'The installer has to run as root. Set a sudo mode on the address rule, or log in as root.'
        })
        continue
      }
      const existing = live?.agent
      if (existing?.state === 'ready' && existing.version === version) {
        findings.push({
          level: 'info',
          label: `${ip} already runs agent ${version}`,
          detail: 'It will be reinstalled over the top. Its existing token and configuration are kept.'
        })
      }
      usable.push(ip)
    }

    if (!usable.length) {
      return { ok: false, findings: findings.length ? findings : [{ level: 'error', label: 'nothing to install on' }] }
    }
    if (usable.length >= rules.installWarnAt) {
      findings.push({
        level: 'warning',
        label: `This will install on ${usable.length} machines`,
        detail: 'Each one downloads the agent and runs its installer. They go in parallel, but it is not instant.'
      })
    }
    findings.push({
      level: 'warning',
      label: 'The agent runs as a service with two extra capabilities',
      detail:
        'CAP_NET_ADMIN and CAP_DAC_READ_SEARCH, so it can read the socket statistics per-process bandwidth needs. It does not run as root.'
    })
    findings.push({
      level: 'pass',
      label: `Install agent ${version} on ${usable.length} machine(s)`,
      detail: `Each downloads ${url} and checks it against sha256 ${sha256.slice(0, 12)}… before unpacking.`
    })

    const token = this.install.issue(values, { ips: usable, url, sha256, version })
    return { ok: true, token, findings }
  }

  /** Run it, as a job with one item per machine. */
  apply(raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const taken = this.install.take(typeof payload.token === 'string' ? payload.token : '', payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const plan = taken.payload
    const config = this.deps.config()
    const rules = this.deps.rules()

    const targets: Array<{ ip: string; cred: TargetRule }> = []
    for (const ip of plan.ips) {
      const cred = resolveCredential(ip, config.targets)
      if (cred) targets.push({ ip, cred })
    }

    this.jobs.start({
      kind: 'agent-install',
      label: `Install agent ${plan.version} on ${targets.length} machine(s)`,
      names: targets.map((target) => target.ip),
      run: async (report, cancelled) => {
        const fanTargets: FanoutTarget[] = targets.map((target) => ({
          ip: target.ip,
          cred: target.cred,
          // Per-target payload: the sudo password belongs to this machine's own
          // credential, and a shared one would carry the wrong password.
          payload: installPayload(target.cred, {
            url: plan.url,
            sha256: plan.sha256,
            version: plan.version
          })
        }))
        const results = await runFanout(this.ctx, fanTargets, '', longRunning(rules), {
          cancelled
        })

        for (const result of results) {
          const outcome = readInstall(result)
          if (outcome.token) this.roster.setToken(outcome.ip, outcome.token)
          report(outcome.ip, outcome.ok, outcome.message)
        }
        // One sweep afterwards rather than a probe per machine: the agents that
        // were just installed all need reading, and that is what a sweep is.
        await this.sweeper.run().catch(() => undefined)
      }
    })
    return { ok: true, data: `Installing on ${targets.length} machine(s).` }
  }

  uninstallCheck(raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const ips = list(values, 'machines')
    if (!ips.length) {
      return { ok: false, findings: [{ level: 'error', label: 'no machines were chosen' }] }
    }
    const purge = values['purge'] === true
    const findings: ModuleCheckFinding[] = [
      {
        level: 'warning',
        label: `The agent will be removed from ${ips.length} machine(s)`,
        detail:
          'Whatever it installed - containers and units - keeps running. Removing the manager is not removing what it manages.'
      }
    ]
    if (purge) {
      findings.push({
        level: 'warning',
        label: 'Its configuration, credentials and telemetry will be deleted too',
        detail:
          'Including the stored platform credentials, and the daily rows it had not been asked for yet. What this app already collected stays.'
      })
    }
    findings.push({
      level: 'pass',
      label: purge ? 'Remove and purge' : 'Remove, keeping configuration',
      detail: ips.join(', ')
    })
    const token = this.remove.issue(values, { ips, purge })
    return { ok: true, token, findings }
  }

  uninstallApply(raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const taken = this.remove.take(typeof payload.token === 'string' ? payload.token : '', payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const plan = taken.payload
    const config = this.deps.config()
    const rules = this.deps.rules()

    const targets: Array<{ ip: string; cred: TargetRule }> = []
    for (const ip of plan.ips) {
      const cred = resolveCredential(ip, config.targets)
      if (cred) targets.push({ ip, cred })
    }

    this.jobs.start({
      kind: 'agent-uninstall',
      label: `Remove the agent from ${targets.length} machine(s)`,
      names: targets.map((target) => target.ip),
      run: async (report, cancelled) => {
        const results = await runFanout(
          this.ctx,
          targets.map((target) => ({
            ip: target.ip,
            cred: target.cred,
            payload: uninstallPayload(target.cred, plan.purge)
          })),
          '',
          longRunning(rules),
          { cancelled }
        )
        for (const result of results) {
          const outcome = readInstall(result)
          if (outcome.ok) this.roster.setToken(result.ip, '')
          report(outcome.ip, outcome.ok, outcome.message)
        }
        await this.sweeper.run().catch(() => undefined)
      }
    })
    return { ok: true, data: `Removing from ${targets.length} machine(s).` }
  }
}

/** Re-exported so the settings page can show what is pinned without importing two files. */
export { AGENT_VERSION, AGENT_SHA256, agentPinned }
