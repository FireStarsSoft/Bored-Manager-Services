/**
 * Everything the user typed: which addresses to watch, how to log in to them,
 * which units matter, and the rule overrides. It lives in the module's own
 * config (`ctx.configGet/Set`, `data/user-settings/module-config/service-fleet.json`)
 * rather than in per-host data, because it is a description of a network the
 * user maintains - it should not change just because the app was pointed at a
 * different jump host, and it has to survive reinstalling the module.
 *
 * The passwords in here are stored **in clear text**. `ctx` offers no
 * encryption, the app's own AES helper is server-private, and pretending
 * otherwise would be worse than saying so: the settings page and the README
 * both say it, and SSH keys are the recommended way in.
 */
import type { ModuleContext } from '@shared/modules'
import { cidrContains, ipToInt, parseCidr, parseRange, type TargetKind } from './net'
import type { FleetRules } from './rules'

export type AuthMode = 'agent' | 'key' | 'password'
export type SudoMode = 'none' | 'sudo-n' | 'sudo-password'

/** One address, block or range, plus how to log in to everything inside it. */
export interface TargetRule {
  id: string
  kind: TargetKind
  /** `10.0.0.5`, `10.0.0.0/24` or `10.0.0.10-40`, per `kind`. */
  value: string
  label?: string
  enabled: boolean
  port: number
  username: string
  auth: AuthMode
  /** Path to a private key **on the jump host**, not on this server. */
  keyPath?: string
  /** Clear text. See the note at the top of this file. */
  password?: string
  sudo: SudoMode
  /** Clear text. */
  sudoPassword?: string
  /** Addresses inside this rule that are not machines, or are not ours. */
  excludes: string[]
  createdAt: number
}

/** A unit the user decided every machine (or some of them) must be running. */
export interface WatchedUnit {
  id: string
  /** Always normalised to `<name>.service`. */
  unit: string
  label?: string
  severity: 'critical' | 'normal'
  /** `docker.io`, or per manager: `apt=docker.io,dnf=moby-engine`. */
  packages?: string
  /** Overrides the package manager entirely. `{{package}}` and `{{unit}}` are filled in. */
  installCommand?: string
  enableOnInstall: boolean
  startOnInstall: boolean
  /** Comma-separated globs over address and label; empty means every machine. */
  appliesTo?: string
}

export interface FleetConfig {
  version: 1
  targets: TargetRule[]
  watched: WatchedUnit[]
  rules: Partial<FleetRules>
}

export const MAX_TARGETS = 200
export const MAX_WATCHED = 100

function emptyConfig(): FleetConfig {
  return { version: 1, targets: [], watched: [], rules: {} }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asPort(value: unknown): number {
  const port = typeof value === 'number' ? Math.trunc(value) : Number.NaN
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 22
}

function asKind(value: unknown): TargetKind {
  return value === 'cidr' || value === 'range' ? value : 'host'
}

function asAuth(value: unknown): AuthMode {
  return value === 'key' || value === 'password' ? value : 'agent'
}

function asSudo(value: unknown): SudoMode {
  return value === 'sudo-n' || value === 'sudo-password' ? value : 'none'
}

/** `docker` and `docker.service` are the same unit; store one of them. */
export function normalizeUnit(raw: string): string {
  const name = raw.trim()
  if (!name) return ''
  return /\.(service|socket|timer|target|path|mount|slice|scope)$/.test(name) ? name : `${name}.service`
}

/**
 * Read defensively: this is a file on disk that a user can edit by hand and an
 * older version of the module can have written.
 */
function normalize(raw: unknown): FleetConfig {
  if (typeof raw !== 'object' || raw === null) return emptyConfig()
  const r = raw as Partial<FleetConfig>
  const targets: TargetRule[] = []
  const seenTargets = new Set<string>()
  for (const entry of Array.isArray(r.targets) ? r.targets : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const t = entry as Partial<TargetRule>
    const id = asString(t.id)
    const value = asString(t.value).trim()
    if (!id || !value || seenTargets.has(id)) continue
    seenTargets.add(id)
    targets.push({
      id,
      kind: asKind(t.kind),
      value,
      label: asString(t.label) || undefined,
      enabled: t.enabled !== false,
      port: asPort(t.port),
      username: asString(t.username, 'root'),
      auth: asAuth(t.auth),
      keyPath: asString(t.keyPath) || undefined,
      password: asString(t.password) || undefined,
      sudo: asSudo(t.sudo),
      sudoPassword: asString(t.sudoPassword) || undefined,
      excludes: (Array.isArray(t.excludes) ? t.excludes : []).filter(
        (x): x is string => typeof x === 'string' && ipToInt(x) != null
      ),
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0
    })
    if (targets.length >= MAX_TARGETS) break
  }
  const watched: WatchedUnit[] = []
  const seenWatched = new Set<string>()
  for (const entry of Array.isArray(r.watched) ? r.watched : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const w = entry as Partial<WatchedUnit>
    const id = asString(w.id)
    const unit = normalizeUnit(asString(w.unit))
    if (!id || !unit || seenWatched.has(id)) continue
    seenWatched.add(id)
    watched.push({
      id,
      unit,
      label: asString(w.label) || undefined,
      severity: w.severity === 'critical' ? 'critical' : 'normal',
      packages: asString(w.packages) || undefined,
      installCommand: asString(w.installCommand) || undefined,
      enableOnInstall: w.enableOnInstall !== false,
      startOnInstall: w.startOnInstall !== false,
      appliesTo: asString(w.appliesTo) || undefined
    })
    if (watched.length >= MAX_WATCHED) break
  }
  const rules =
    typeof r.rules === 'object' && r.rules !== null ? (r.rules as Partial<FleetRules>) : {}
  return { version: 1, targets, watched, rules }
}

/**
 * Reads through a cache and writes through it. Unlike per-host data this is not
 * keyed by the connected machine, so the cache only has to be dropped when this
 * module writes - and on reset, in case something else rewrote the file while
 * the module was idle.
 */
export class ConfigStore {
  private cache: FleetConfig | null = null

  constructor(private ctx: ModuleContext) {}

  read(): FleetConfig {
    if (!this.cache) this.cache = normalize(this.ctx.configGet())
    return this.cache
  }

  /**
   * Mutate the document and persist it. A failed write (over the 512 KB cap, a
   * read-only app folder) leaves the change in memory and throws, so the caller
   * can tell the user rather than pretending it was saved.
   */
  update<T>(mutate: (config: FleetConfig) => T): T {
    const config = this.read()
    const result = mutate(config)
    this.ctx.configSet(config)
    return result
  }

  reset(): void {
    this.cache = null
  }
}

/** A short id that reads as what it is in a JSON file someone opens by hand. */
export function makeId(prefix: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `${prefix}_${Math.random().toString(16).slice(2, 6)}`
    if (!taken.has(id)) return id
  }
  return `${prefix}_${Date.now().toString(16)}`
}

/** How many addresses a rule's own `kind` implies, for narrowest-wins below. */
function ruleSpread(rule: TargetRule): number {
  if (rule.kind === 'host') return 1
  if (rule.kind === 'cidr') {
    const cidr = parseCidr(rule.value)
    return cidr ? 2 ** (32 - cidr.prefix) : Number.MAX_SAFE_INTEGER
  }
  const range = parseRange(rule.value)
  return range ? range.to - range.from + 1 : Number.MAX_SAFE_INTEGER
}

export function ruleCovers(rule: TargetRule, ip: string): boolean {
  const value = ipToInt(ip)
  if (value == null) return false
  if (rule.excludes.some((x) => ipToInt(x) === value)) return false
  if (rule.kind === 'host') return ipToInt(rule.value) === value
  if (rule.kind === 'cidr') {
    const cidr = parseCidr(rule.value)
    return cidr != null && cidrContains(cidr, value)
  }
  const range = parseRange(rule.value)
  return range != null && value >= range.from && value <= range.to
}

/**
 * Which credentials one address is reached with: the narrowest rule that covers
 * it wins, so a single machine with its own login beats the subnet-wide default
 * it sits inside. Disabled rules are not consulted at all.
 */
export function resolveCredential(ip: string, targets: readonly TargetRule[]): TargetRule | null {
  let best: TargetRule | null = null
  let bestSpread = Number.MAX_SAFE_INTEGER
  for (const rule of targets) {
    if (!rule.enabled || !ruleCovers(rule, ip)) continue
    const spread = ruleSpread(rule)
    if (spread < bestSpread) {
      best = rule
      bestSpread = spread
    }
  }
  return best
}
