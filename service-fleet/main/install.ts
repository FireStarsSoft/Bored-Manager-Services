/**
 * Installing a service on every machine that is missing it, which is the reason
 * the module exists rather than a convenience: doing it by hand is one SSH
 * session, one package manager and one `enable --now` per machine.
 *
 * The check resolves the **exact commands** per machine and freezes them into the
 * token. Apply runs what the report said, not a fresh guess: a machine whose
 * package manager the check could not work out is refused there and then, not
 * halfway through a job.
 */
import {
  createCheckSession,
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import { shQuote } from '@shared/shell'
import type { OkResult } from '@shared/types'
import type { Actions, HostSteps } from './actions'
import { resolveCredential, type FleetConfig, type WatchedUnit } from './config'
import { matchesGlob } from './net'
import { watchedFor, type HostLive, type Roster } from './roster'
import type { FleetRules } from './rules'
import type { Step } from './units'

interface HostPlan {
  ip: string
  /** Already-quoted commands, in the order they will run. */
  steps: Step[]
  /** What the machine will have installed, for the report. */
  packageName: string
  manager: string
}

interface InstallPlan {
  unit: string
  hosts: HostPlan[]
}

/** `apt-get` is the binary; `apt` is what a package spec calls it. */
const MANAGER_ALIAS: Record<string, string> = {
  'apt-get': 'apt',
  apt: 'apt',
  dnf: 'dnf',
  yum: 'yum',
  zypper: 'zypper',
  pacman: 'pacman',
  apk: 'apk'
}

const INSTALL_TEMPLATE: Record<string, (pkg: string) => string> = {
  apt: (pkg) => `DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg}`,
  dnf: (pkg) => `dnf install -y ${pkg}`,
  yum: (pkg) => `yum install -y ${pkg}`,
  zypper: (pkg) => `zypper --non-interactive install ${pkg}`,
  pacman: (pkg) => `pacman -S --noconfirm ${pkg}`,
  apk: (pkg) => `apk add --no-cache ${pkg}`
}

const REFRESH_TEMPLATE: Record<string, string> = {
  apt: 'DEBIAN_FRONTEND=noninteractive apt-get update',
  dnf: 'dnf makecache',
  yum: 'yum makecache',
  zypper: 'zypper --non-interactive refresh',
  pacman: 'pacman -Sy --noconfirm',
  apk: 'apk update'
}

/**
 * Which package to ask for on this machine. A bare spec is the same everywhere;
 * `apt=docker.io,dnf=moby-engine` says it is not, because the same service is
 * not called the same thing on two distributions.
 */
export function packageFor(spec: string | undefined, manager: string): string | null {
  const text = (spec ?? '').trim()
  if (!text) return null
  if (!text.includes('=')) return text
  for (const part of text.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const value = part.slice(eq + 1).trim()
    if (value && (key === manager || MANAGER_ALIAS[key] === manager)) return value
  }
  return null
}

export class Installer {
  private session = createCheckSession<InstallPlan>()

  constructor(
    private roster: Roster,
    private actions: Actions,
    private deps: { config: () => FleetConfig; rules: () => FleetRules }
  ) {}

  clear(): void {
    this.session.clear()
  }

  private stepsFor(
    def: WatchedUnit,
    live: HostLive,
    opts: { refresh: boolean; enable: boolean; start: boolean }
  ): { plan: HostPlan | null; problem: string | null } {
    const manager = MANAGER_ALIAS[live.facts?.pkg ?? ''] ?? ''
    const custom = (def.installCommand ?? '').trim()
    const packageName = packageFor(def.packages, manager)
    if (!custom && !packageName) {
      return {
        plan: null,
        problem: manager
          ? `${live.ip}: no package is set for ${manager}`
          : `${live.ip}: no package manager was found, so only a custom install command can work here`
      }
    }
    const steps: Step[] = []
    const quoted = packageName ? shQuote(packageName) : ''
    if (custom) {
      steps.push({
        name: 'install',
        command: custom.split('{{package}}').join(packageName ?? '').split('{{unit}}').join(def.unit)
      })
    } else {
      if (opts.refresh && REFRESH_TEMPLATE[manager]) {
        steps.push({ name: 'refresh package index', command: REFRESH_TEMPLATE[manager] })
      }
      const template = INSTALL_TEMPLATE[manager]
      if (!template) {
        return { plan: null, problem: `${live.ip}: ${manager || 'that package manager'} is not one this module knows` }
      }
      steps.push({ name: `install ${packageName}`, command: template(quoted) })
    }
    if (opts.enable) steps.push({ name: `enable ${def.unit}`, command: `systemctl enable ${shQuote(def.unit)}` })
    if (opts.start) steps.push({ name: `start ${def.unit}`, command: `systemctl start ${shQuote(def.unit)}` })
    return {
      plan: { ip: live.ip, steps, packageName: packageName ?? '(custom command)', manager: manager || 'none' },
      problem: null
    }
  }

  check(raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const config = this.deps.config()
    const rules = this.deps.rules()
    const watchedId = String(values['watchedId'] ?? '')
    const def = config.watched.find((entry) => entry.id === watchedId)
    if (!def) {
      return failedCheck(
        'Pick a service',
        'Bulk install works from the watched services list, so the same definition is what gets installed and what gets checked afterwards. Add one under Watched services first.'
      )
    }
    const hostGlob = String(values['hosts'] ?? '')
    const onlyMissing = values['onlyMissing'] !== false
    const refresh = values['refresh'] === true
    const enable = values['enable'] !== false
    const start = values['start'] !== false

    const findings: ModuleCheckFinding[] = []
    const hosts: HostPlan[] = []
    const problems: string[] = []
    const alreadyThere: string[] = []
    const notApplicable: string[] = []
    const unreachable: string[] = []

    for (const live of this.roster.controllable(config.targets)) {
      if (!matchesGlob(hostGlob, [live.ip, live.cred.label])) continue
      const problem = this.actions.controlProblem(live.ip)
      if (problem) {
        unreachable.push(problem)
        continue
      }
      // A watched unit can be scoped to some machines; installing it somewhere it
      // is not wanted would create the drift the page is meant to show.
      if (!watchedFor([def], live.ip, live.cred.label).length) {
        notApplicable.push(live.ip)
        continue
      }
      const installed = live.watched.find((entry) => entry.def.id === def.id)?.state
      if (onlyMissing && installed && installed.load !== 'not-found') {
        alreadyThere.push(live.ip)
        continue
      }
      const { plan, problem: why } = this.stepsFor(def, live, { refresh, enable, start })
      if (plan) hosts.push(plan)
      else if (why) problems.push(why)
    }

    if (hosts.length === 0) {
      const detail =
        problems[0] ??
        (alreadyThere.length
          ? `Every matching machine already has ${def.unit}. Untick "only machines missing it" to reinstall.`
          : notApplicable.length
            ? `${def.unit} is scoped to "${def.appliesTo}", which none of the matching machines are in.`
            : unreachable[0] ?? 'No machine in the roster matches, or none of them can be controlled.')
      return failedCheck(`Nothing to install ${def.unit} on`, detail)
    }

    const managers = [...new Set(hosts.map((host) => host.manager))]
    findings.push({
      level: 'pass',
      label: `Will install ${def.unit} on ${hosts.length} machine${hosts.length === 1 ? '' : 's'}`,
      detail: hosts
        .slice(0, 8)
        .map((host) => `${host.ip} (${host.manager}: ${host.packageName})`)
        .join(', ')
        .concat(hosts.length > 8 ? `, and ${hosts.length - 8} more` : '')
    })
    findings.push({
      level: 'pass',
      label: 'Commands each machine will run',
      detail: hosts[0].steps.map((step) => step.command).join(' && ')
    })
    if (managers.length > 1) {
      findings.push({
        level: 'info',
        label: `${managers.length} different package managers in this batch`,
        detail: managers.join(', ')
      })
    }
    if (alreadyThere.length) {
      findings.push({
        level: 'info',
        label: `${alreadyThere.length} machine${alreadyThere.length === 1 ? '' : 's'} already have it`,
        detail: alreadyThere.slice(0, 8).join(', ')
      })
    }
    if (notApplicable.length) {
      findings.push({
        level: 'info',
        label: `${notApplicable.length} machine${notApplicable.length === 1 ? '' : 's'} are outside this service's scope`,
        detail: `"${def.appliesTo}" does not cover ${notApplicable.slice(0, 6).join(', ')}`
      })
    }
    if (unreachable.length) {
      findings.push({
        level: 'warning',
        label: `${unreachable.length} machine${unreachable.length === 1 ? '' : 's'} cannot be installed on`,
        detail: [...new Set(unreachable)].slice(0, 4).join('; ')
      })
    }
    if (problems.length) {
      findings.push({
        level: 'warning',
        label: `${problems.length} machine${problems.length === 1 ? '' : 's'} have no usable package for this service`,
        detail: problems.slice(0, 4).join('; ')
      })
    }
    if (hosts.length > rules.installWarnAt) {
      findings.push({
        level: 'warning',
        label: `That is more than the ${rules.installWarnAt} this install warns at`,
        detail: 'Installing a package changes the machine and cannot be undone by cancelling the job.'
      })
    }
    if (!refresh) {
      findings.push({
        level: 'info',
        label: 'The package index is not refreshed first',
        detail: 'A machine that has never updated may not find the package. Tick "refresh the package index" if so.'
      })
    }

    const ok = !hasBlockingFinding(findings)
    return ok ? { ok, token: this.session.issue(values, { unit: def.unit, hosts }), findings } : { ok, findings }
  }

  apply(raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const config = this.deps.config()
    const work: HostSteps[] = []
    for (const host of taken.payload.hosts) {
      const cred = resolveCredential(host.ip, config.targets)
      if (!cred) continue
      work.push({ ip: host.ip, cred, steps: host.steps })
    }
    if (work.length === 0) {
      return { ok: false, error: 'none of the machines in that plan are covered by an address rule any more' }
    }
    const job = this.actions.startJob(
      'install',
      `install ${taken.payload.unit} on ${work.length} machine${work.length === 1 ? '' : 's'}`,
      work
    )
    return { ok: true, data: job.id }
  }
}
