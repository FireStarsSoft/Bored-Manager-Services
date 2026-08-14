/**
 * The three things the user maintains - which addresses to watch, which services
 * matter, and the rules everything measures against - each behind the same
 * check-then-apply step as every other change in this module.
 *
 * A target rule is the one place a password is typed, so its check is also where
 * the "this is stored in clear text" warning belongs: not buried in a README, but
 * in the report the user reads immediately before saving it.
 */
import {
  createCheckSession,
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import {
  makeId,
  normalizeUnit,
  ruleCovers,
  type AuthMode,
  type ConfigStore,
  type FleetConfig,
  type SudoMode,
  type TargetRule,
  type WatchedUnit
} from './config'
import { classifyReach, reachMessage, runFanout } from './fanout'
import { enumerateRule, ipToInt, matchesGlob, type TargetKind } from './net'
import type { JumpCapabilities } from './probe'
import type { Roster } from './roster'
import {
  DEFAULT_RULES,
  RULE_BOUNDS,
  RULE_UNUSUAL,
  effectiveRules,
  type FleetRules,
  type UnitScope
} from './rules'
import { isValidUnit } from './units'

function text(values: Record<string, unknown>, key: string): string {
  const raw = values[key]
  return typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw)
}

function asKind(value: string): TargetKind {
  return value === 'cidr' || value === 'range' ? value : 'host'
}

function asAuth(value: string): AuthMode {
  return value === 'key' || value === 'password' ? value : 'agent'
}

function asSudo(value: string): SudoMode {
  return value === 'sudo-n' || value === 'sudo-password' ? value : 'none'
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

// ---------------------------------------------------------------- targets

/** What the check resolved, so the apply writes exactly the rule that was read. */
interface TargetPlan {
  rule: TargetRule
  /** Null when this is a new rule. */
  editing: string | null
}

export class TargetEditor {
  private session = createCheckSession<TargetPlan>()
  /** Last result of "Test", per rule id. In memory: it is a fact about now, not a setting. */
  private lastTest = new Map<string, string>()

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore,
    private roster: Roster,
    private deps: { rules: () => FleetRules; capabilities: () => JumpCapabilities }
  ) {}

  clear(): void {
    this.session.clear()
  }

  /** The table on the settings page. Never includes a password, only whether there is one. */
  rows(): Array<Record<string, unknown>> {
    const rules = this.deps.rules()
    return this.store.read().targets.map((rule) => {
      const listed = enumerateRule(rule.kind, rule.value, rules.maxHosts)
      const known = Object.keys(this.roster.records()).filter((ip) => ruleCovers(rule, ip)).length
      return {
        id: rule.id,
        value: rule.value,
        kind: rule.kind,
        label: rule.label ?? '',
        enabled: rule.enabled ? 'yes' : '',
        // The same fact twice: a word for the column, a boolean for the edit
        // form's tick box, which only starts checked for a real `true`.
        enabledFlag: rule.enabled,
        addresses: listed.problem ? 0 : listed.total,
        machines: known,
        username: rule.username,
        port: rule.port,
        auth: rule.auth,
        keyPath: rule.keyPath ?? '',
        hasPassword: rule.password ? 'yes' : '',
        sudo: rule.sudo,
        hasSudoPassword: rule.sudoPassword ? 'yes' : '',
        excludes: rule.excludes.join(', '),
        problem: listed.problem ?? '',
        lastTest: this.lastTest.get(rule.id) ?? ''
      }
    })
  }

  check(editingId: string | null, raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const config = this.store.read()
    const existing = editingId ? config.targets.find((rule) => rule.id === editingId) : undefined
    if (editingId && !existing) return failedCheck('That address rule is gone', 'Somebody removed it while this form was open.')

    const findings: ModuleCheckFinding[] = []
    const kind = asKind(text(values, 'kind'))
    const value = text(values, 'value')
    const username = text(values, 'username') || 'root'
    const auth = asAuth(text(values, 'auth'))
    const sudo = asSudo(text(values, 'sudo'))
    const keyPath = text(values, 'keyPath')
    const password = text(values, 'password')
    const sudoPassword = text(values, 'sudoPassword')
    const portText = text(values, 'port')
    const port = portText === '' ? 22 : Number(portText)
    const rules = this.deps.rules()
    const capabilities = this.deps.capabilities()

    if (!value) return failedCheck('Enter an address', 'A single address, a CIDR block, or a range.')
    const listed = enumerateRule(kind, value, rules.maxHosts)
    if (listed.problem) return failedCheck('That is not an address this module can read', listed.problem)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      findings.push({ level: 'error', label: `Port ${portText} is not a port number` })
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
      findings.push({ level: 'error', label: `"${username}" is not a user name` })
    }
    if (listed.total > rules.maxHosts) {
      findings.push({
        level: 'error',
        label: `${value} covers ${listed.total} addresses, more than the ${rules.maxHosts} allowed`,
        detail: 'Narrow the block, or raise "Largest address range" in Rules.'
      })
    }

    // Credentials the jump host could not actually use are an error here rather
    // than the same failure repeated once per machine at the next sweep.
    if (auth === 'key' && !keyPath) {
      findings.push({
        level: 'error',
        label: 'Key authentication needs a key path',
        detail: 'The path is read on the machine this app is connected to, not on this server.'
      })
    }
    const keepingPassword = existing?.password && !password
    if (auth === 'password' && !password && !keepingPassword) {
      findings.push({ level: 'error', label: 'Password authentication needs a password' })
    }
    if (auth === 'password' && !capabilities.sshpass) {
      findings.push({
        level: 'error',
        label: 'The connected machine has no sshpass',
        detail: 'Install sshpass on it, or use an SSH key for this address.'
      })
    }
    const keepingSudoPassword = existing?.sudoPassword && !sudoPassword
    if (sudo === 'sudo-password' && !sudoPassword && !keepingSudoPassword) {
      findings.push({ level: 'error', label: 'That sudo mode needs a sudo password' })
    }

    const excludes = splitList(text(values, 'excludes'))
    const badExcludes = excludes.filter((ip) => ipToInt(ip) == null)
    if (badExcludes.length) {
      findings.push({ level: 'error', label: `Not addresses: ${badExcludes.join(', ')}` })
    }

    if (hasBlockingFinding(findings)) return { ok: false, findings }

    const first = listed.ips[0]
    const last = listed.ips[listed.ips.length - 1]
    findings.push({
      level: 'pass',
      label: `Will watch ${listed.ips.length} address${listed.ips.length === 1 ? '' : 'es'}${
        listed.ips.length > 1 ? ` from ${first} to ${last}` : ` (${first})` }`,
      detail: `As ${username} on port ${port}, using ${
        auth === 'agent' ? 'the agent or default keys' : auth === 'key' ? `the key at ${keyPath}` : 'a password'
      }; ${
        sudo === 'none'
          ? 'read-only (no sudo)'
          : sudo === 'sudo-n'
            ? 'control through passwordless sudo'
            : 'control through sudo with a password'
      }.`
    })

    if (password || sudoPassword || keepingPassword || keepingSudoPassword) {
      findings.push({
        level: 'warning',
        label: 'Passwords for this address are stored in clear text',
        detail:
          'They go into data/user-settings/module-config/service-fleet.json on this server, unencrypted, because a module has no way to encrypt them. An SSH key leaves nothing to store.'
      })
    }
    if (auth === 'password') {
      findings.push({
        level: 'info',
        label: 'Following a log needs connection sharing on a password login',
        detail: 'Keep "Keep SSH connections warm" above 0 in Rules, or use a key for this address.'
      })
    }
    if (!rules.strictHostKey) {
      findings.push({
        level: 'info',
        label: 'Host keys are not checked',
        detail: 'Fine on a network you own; turn on strict host key checking in Rules if it is not.'
      })
    }

    // Overlaps are legal and useful - a single machine inside a subnet rule is
    // how one machine gets its own login - so this explains rather than refuses.
    const overlapping = config.targets.filter(
      (other) => other.id !== editingId && listed.ips.some((ip) => ruleCovers(other, ip))
    )
    if (overlapping.length) {
      findings.push({
        level: 'info',
        label: `Overlaps ${overlapping.length} existing rule${overlapping.length === 1 ? '' : 's'}`,
        detail: `${overlapping
          .map((other) => other.value)
          .join(', ')}. The narrowest rule covering an address wins, so a single address always beats the block it sits in.`
      })
    }
    if (excludes.length) {
      findings.push({
        level: 'info',
        label: `${excludes.length} address${excludes.length === 1 ? '' : 'es'} excluded`,
        detail: excludes.join(', ')
      })
    }
    if (listed.truncated) {
      findings.push({
        level: 'warning',
        label: `Only the first ${listed.ips.length} of ${listed.total} addresses will be swept`,
        detail: 'Raise "Largest address range" in Rules to cover the whole block.'
      })
    }

    const rule: TargetRule = {
      id: existing?.id ?? makeId('t', new Set(config.targets.map((entry) => entry.id))),
      kind,
      value,
      label: text(values, 'label') || undefined,
      enabled: values['enabled'] !== false,
      port,
      username,
      auth,
      keyPath: keyPath || undefined,
      password: password || (keepingPassword ? existing?.password : undefined),
      sudo,
      sudoPassword: sudoPassword || (keepingSudoPassword ? existing?.sudoPassword : undefined),
      excludes,
      createdAt: existing?.createdAt ?? Date.now()
    }
    return { ok: true, token: this.session.issue(values, { rule, editing: editingId }), findings }
  }

  apply(editingId: string | null, raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    if (taken.payload.editing !== editingId) return { ok: false, error: 'that check was for a different rule' }
    const { rule } = taken.payload
    this.store.update((config) => {
      const at = config.targets.findIndex((entry) => entry.id === rule.id)
      if (at >= 0) config.targets[at] = rule
      else config.targets.push(rule)
    })
    this.ctx.log(`service-fleet: address rule ${rule.value} ${editingId ? 'updated' : 'added'}`)
    return { ok: true }
  }

  delete(idRaw: unknown): OkResult {
    const id = String(idRaw ?? '')
    const removed = this.store.update((config) => {
      const before = config.targets.length
      config.targets = config.targets.filter((rule) => rule.id !== id)
      return before !== config.targets.length
    })
    if (!removed) return { ok: false, error: 'no such address rule' }
    this.lastTest.delete(id)
    // Machines only that rule reached are no longer anybody's, so their rows go
    // with it rather than sitting there permanently unreachable.
    const pruned = this.roster.pruneUnclaimed(this.store.read().targets)
    return { ok: true, data: pruned ? `${pruned} machine(s) dropped from the roster` : undefined }
  }

  /** Try the first few addresses of one rule and say what happened, without waiting for a sweep. */
  async test(idRaw: unknown): Promise<OkResult> {
    const id = String(idRaw ?? '')
    const rule = this.store.read().targets.find((entry) => entry.id === id)
    if (!rule) return { ok: false, error: 'no such address rule' }
    const rules = this.deps.rules()
    const listed = enumerateRule(rule.kind, rule.value, rules.maxHosts)
    if (listed.problem) return { ok: false, error: listed.problem }
    const sample = listed.ips.slice(0, 4)
    const results = await runFanout(
      this.ctx,
      sample.map((ip) => ({ ip, cred: rule })),
      'echo ok\n',
      rules
    )
    const lines = results.map((result) => {
      const reach = classifyReach(result)
      return `${result.ip}: ${reach === 'ok' ? 'ok' : reachMessage(reach, result)}`
    })
    const okCount = results.filter((result) => classifyReach(result) === 'ok').length
    const summary = `${okCount}/${results.length} answered${listed.ips.length > sample.length ? ` (first ${sample.length} of ${listed.ips.length})` : ''}`
    this.lastTest.set(id, `${summary} - ${lines.join('; ')}`.slice(0, 300))
    this.ctx.log(`service-fleet: tested ${rule.value}: ${summary}`)
    return okCount > 0 ? { ok: true, data: summary } : { ok: false, error: lines.join('; ') || summary }
  }
}

// ---------------------------------------------------------------- watched units

export class WatchedEditor {
  private session = createCheckSession<WatchedUnit>()

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore,
    private roster: Roster
  ) {}

  clear(): void {
    this.session.clear()
  }

  rows(): Array<Record<string, unknown>> {
    const records = Object.values(this.roster.records())
    return this.store.read().watched.map((def) => {
      const scope = records.filter((record) => matchesGlob(def.appliesTo, [record.ip, record.label]))
      let down = 0
      for (const record of scope) {
        const live = this.roster.liveFor(record.ip)
        const state = live?.watched.find((entry) => entry.def.id === def.id)?.state
        if (!state || state.active !== 'active') down++
      }
      return {
        id: def.id,
        unit: def.unit,
        label: def.label ?? '',
        severity: def.severity,
        appliesTo: def.appliesTo ?? 'every machine',
        appliesToRaw: def.appliesTo ?? '',
        machines: scope.length,
        down,
        packages: def.packages ?? '',
        installCommand: def.installCommand ?? '',
        enableFlag: def.enableOnInstall,
        startFlag: def.startOnInstall,
        onInstall: [def.enableOnInstall ? 'enable' : '', def.startOnInstall ? 'start' : '']
          .filter((part) => part)
          .join(' + ')
      }
    })
  }

  check(editingId: string | null, raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const config = this.store.read()
    const existing = editingId ? config.watched.find((entry) => entry.id === editingId) : undefined
    if (editingId && !existing) return failedCheck('That service is gone', 'Somebody removed it while this form was open.')

    const findings: ModuleCheckFinding[] = []
    const unit = normalizeUnit(text(values, 'unit'))
    if (!unit) return failedCheck('Enter a unit name', 'For example `docker` or `nginx.service`.')
    if (!isValidUnit(unit)) {
      return failedCheck(
        `"${unit}" is not a unit name`,
        'Letters, digits, and @ : _ . - only, ending in .service (or .socket, .timer, .target, .path, .mount).'
      )
    }
    const clash = config.watched.find((entry) => entry.unit === unit && entry.id !== editingId)
    if (clash) findings.push({ level: 'error', label: `${unit} is already watched`, detail: 'Edit that entry instead.' })

    const appliesTo = text(values, 'appliesTo')
    const packages = text(values, 'packages')
    const installCommand = text(values, 'installCommand')
    const severity = text(values, 'severity') === 'critical' ? 'critical' : 'normal'
    if (installCommand && /https?:\/\//i.test(installCommand)) {
      findings.push({
        level: 'error',
        label: 'An install command may not fetch from a URL',
        detail: 'Modules install from the machine\'s own package manager, not from the internet.'
      })
    }
    if (hasBlockingFinding(findings)) return { ok: false, findings }

    const records = Object.values(this.roster.records())
    const scope = records.filter((record) => matchesGlob(appliesTo, [record.ip, record.label]))
    findings.push({
      level: 'pass',
      label: `${unit} will be watched on ${appliesTo ? `machines matching "${appliesTo}"` : 'every machine'}`,
      detail: `${scope.length} of the ${records.length} machines in the roster match right now.${
        severity === 'critical'
          ? ' Marked critical: a machine missing it or not running it goes red rather than amber.'
          : ' A machine missing it or not running it goes amber.'
      }`
    })
    if (appliesTo && scope.length === 0 && records.length > 0) {
      findings.push({
        level: 'warning',
        label: 'No machine in the roster matches that filter',
        detail: 'It will be watched on nothing until one does. Globs match the address or the rule label, e.g. `10.0.0.*`.'
      })
    }
    if (!packages && !installCommand) {
      findings.push({
        level: 'info',
        label: 'Bulk install will not be able to install it',
        detail: 'Add a package name (or a per-manager list like `apt=docker.io,dnf=moby-engine`) to install it in bulk.'
      })
    }
    if (installCommand) {
      findings.push({
        level: 'warning',
        label: 'A custom install command replaces the package manager entirely',
        detail: `It runs as root through sudo, once per machine: ${installCommand}`
      })
    }

    const def: WatchedUnit = {
      id: existing?.id ?? makeId('w', new Set(config.watched.map((entry) => entry.id))),
      unit,
      label: text(values, 'label') || undefined,
      severity,
      packages: packages || undefined,
      installCommand: installCommand || undefined,
      enableOnInstall: values['enableOnInstall'] !== false,
      startOnInstall: values['startOnInstall'] !== false,
      appliesTo: appliesTo || undefined
    }
    return { ok: true, token: this.session.issue(values, def), findings }
  }

  apply(editingId: string | null, raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const def = taken.payload
    if (editingId && def.id !== editingId) return { ok: false, error: 'that check was for a different service' }
    this.store.update((config) => {
      const at = config.watched.findIndex((entry) => entry.id === def.id)
      if (at >= 0) config.watched[at] = def
      else config.watched.push(def)
    })
    this.ctx.log(`service-fleet: watched service ${def.unit} ${editingId ? 'updated' : 'added'}`)
    return { ok: true }
  }

  delete(idRaw: unknown): OkResult {
    const id = String(idRaw ?? '')
    const removed = this.store.update((config) => {
      const before = config.watched.length
      config.watched = config.watched.filter((entry) => entry.id !== id)
      return before !== config.watched.length
    })
    return removed ? { ok: true } : { ok: false, error: 'no such watched service' }
  }
}

// ---------------------------------------------------------------- rules

type RuleOverrides = Partial<Record<keyof FleetRules, number | boolean | UnitScope>>

const UNIT_SCOPES: UnitScope[] = ['watched', 'running', 'all']

export class RulesEditor {
  private session = createCheckSession<RuleOverrides>()

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore
  ) {}

  /**
   * One row per rule, already labelled "(default)" or "(custom)": a `keyValue`
   * block prints what it is given, and working out which is which needs the
   * defaults, which only this half has.
   */
  effective(): Record<string, string> {
    const rules = effectiveRules(this.ctx)
    const out: Record<string, string> = {}
    for (const key of Object.keys(DEFAULT_RULES) as Array<keyof FleetRules>) {
      const value = rules[key]
      out[key] = `${String(value)} (${value === DEFAULT_RULES[key] ? 'default' : 'custom'})`
    }
    return out
  }

  check(raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const findings: ModuleCheckFinding[] = []
    const overrides: RuleOverrides = {}

    // Numbers arrive as text on purpose: an empty `number` input is sent as 0,
    // which is indistinguishable from somebody meaning 0, and "empty means the
    // default" is worth more here than a spinner.
    for (const [key, bounds] of Object.entries(RULE_BOUNDS)) {
      const entered = text(values, key)
      if (entered === '') continue
      const value = Number(entered)
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        findings.push({ level: 'error', label: `${bounds.label}: "${entered}" is not a whole number` })
        continue
      }
      if (value < bounds.min || value > bounds.max) {
        findings.push({
          level: 'error',
          label: `${bounds.label} must be between ${bounds.min} and ${bounds.max}`,
          detail: `You entered ${value}.`
        })
        continue
      }
      const unusual = RULE_UNUSUAL[key]?.(value)
      if (unusual) findings.push({ level: 'warning', label: `${bounds.label} = ${value}`, detail: unusual })
      overrides[key as keyof FleetRules] = value
    }

    const scope = text(values, 'unitScope')
    if (UNIT_SCOPES.includes(scope as UnitScope)) {
      overrides.unitScope = scope as UnitScope
      if (scope === 'all') {
        findings.push({
          level: 'warning',
          label: 'Listing every unit makes each sweep much larger',
          detail: 'A machine has hundreds of units including inactive ones. Sensible for a handful of machines, not for a subnet.'
        })
      }
      if (scope === 'watched') {
        findings.push({
          level: 'info',
          label: 'Only watched services will be listed',
          detail: 'Cards will show nothing else, and the Services page will only have the units you named.'
        })
      }
    }

    // Checkboxes are always sent, so they are always an override - the form
    // writes them as shown, which is why the values in force are printed above it.
    for (const key of ['strictHostKey', 'criticalDownIsRed'] as const) {
      if (typeof values[key] === 'boolean') overrides[key] = values[key] as boolean
    }
    if (overrides.strictHostKey === true) {
      findings.push({
        level: 'warning',
        label: 'Strict host key checking will be on',
        detail:
          'Every machine has to already be in the known_hosts of the account this app connects as, or it will be refused.'
      })
    }

    const changed = Object.entries(overrides).filter(
      ([key, value]) => value !== DEFAULT_RULES[key as keyof FleetRules]
    )
    const cleared = Object.keys(RULE_BOUNDS).filter((key) => !(key in overrides))
    findings.push({
      level: 'pass',
      label: changed.length
        ? `${changed.length} rule${changed.length === 1 ? '' : 's'} will differ from the defaults`
        : 'Every rule will be back at its default',
      detail: changed.length ? changed.map(([key, value]) => `${key} = ${String(value)}`).join(', ') : undefined
    })
    if (cleared.length && changed.length) {
      findings.push({
        level: 'info',
        label: `${cleared.length} field${cleared.length === 1 ? '' : 's'} left empty will use the default`,
        detail: cleared.join(', ')
      })
    }

    const ok = !hasBlockingFinding(findings)
    return ok ? { ok, token: this.session.issue(values, overrides), findings } : { ok, findings }
  }

  apply(raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    // Only what actually differs is stored, so a later change to a default is
    // picked up instead of being masked by a copy of the old one.
    const kept: RuleOverrides = {}
    for (const [key, value] of Object.entries(taken.payload)) {
      if (value === DEFAULT_RULES[key as keyof FleetRules]) continue
      kept[key as keyof FleetRules] = value as number | boolean | UnitScope
    }
    this.write(kept)
    this.ctx.log(`service-fleet: rule overrides saved: ${Object.keys(kept).join(', ') || 'none'}`)
    return { ok: true }
  }

  reset(): OkResult {
    this.write({})
    this.ctx.log('service-fleet: rule overrides cleared')
    return { ok: true }
  }

  /** Through the store, so the cached targets and watched list stay in step with the file. */
  private write(rules: RuleOverrides): void {
    this.store.update((config) => {
      config.rules = rules as FleetConfig['rules']
    })
  }
}
