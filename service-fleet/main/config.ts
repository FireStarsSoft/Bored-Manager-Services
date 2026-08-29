/**
 * Everything the user typed: which addresses to watch, how to log in to them,
 * which units matter, and the rule overrides. It lives in the module's own
 * config (`ctx.configGet/Set`, `data/user-settings/module-config/service-fleet.json`)
 * rather than in per-host data, because it is a description of a network the
 * user maintains - it should not change just because the app was pointed at a
 * different jump host, and it has to survive reinstalling the module.
 *
 * The passwords in here are stored **in clear text**, and so are the agent
 * tokens in `store.ts`. `ctx` offers no encryption, the app's own AES helper is
 * server-private, and pretending otherwise would be worse than saying so: the
 * settings page and the README both say it, and SSH keys are the recommended
 * way in.
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

/**
 * One template the user wrote or imported, kept as the raw document.
 *
 * Raw rather than parsed, for the same reason the agent keeps its own copies
 * raw: it is re-validated on every read, so a document accepted by an older
 * version of the schema stops loading when the rules tighten instead of being
 * trusted forever because it was trusted once.
 *
 * The templates that ship with the module are **not** in here. They live in
 * `service-fleet/templates/`, are part of the module folder hash, and are
 * read-only - this is only what the user added on top.
 */
export interface StoredTemplate {
  id: string
  /** The template document, exactly as it was imported. */
  document: unknown
  addedAt: number
  updatedAt: number
}

export interface FleetConfig {
  version: 1
  targets: TargetRule[]
  templates: StoredTemplate[]
  rules: Partial<FleetRules>
  /** Whether the explanatory notes are shown on every page. */
  hintsOn: boolean
}

export const MAX_TARGETS = 200

function emptyConfig(): FleetConfig {
  return { version: 1, targets: [], templates: [], rules: {}, hintsOn: true }
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
  const templates: StoredTemplate[] = []
  const seenTemplates = new Set<string>()
  for (const entry of Array.isArray(r.templates) ? r.templates : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const t = entry as Partial<StoredTemplate>
    const id = asString(t.id)
    if (!id || seenTemplates.has(id) || typeof t.document !== 'object' || t.document === null) continue
    seenTemplates.add(id)
    templates.push({
      id,
      document: t.document,
      addedAt: typeof t.addedAt === 'number' ? t.addedAt : 0,
      updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0
    })
  }
  const rules =
    typeof r.rules === 'object' && r.rules !== null ? (r.rules as Partial<FleetRules>) : {}
  return { version: 1, targets, templates, rules, hintsOn: r.hintsOn !== false }
}

/**
 * Config is shared by every connected-machine instance of this module, and
 * the file is documented as one a user may hand-edit. Read it afresh so an
 * edit made from one connected machine - or by hand, while nothing is
 * connected to it at all - is immediately visible to every instance and
 * cannot be overwritten from a stale cache. It used to cache indefinitely,
 * so a second connected machine's edit could silently vanish under whichever
 * instance wrote next.
 */
export class ConfigStore {
  constructor(private ctx: ModuleContext) {}

  read(): FleetConfig {
    return normalize(this.ctx.configGet())
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
    // No in-memory document to invalidate.
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
