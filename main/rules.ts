/**
 * The limits every sweep and every check measures against. They are defaults,
 * not constants: how hard you may lean on one jump host depends on the machine
 * and on how many machines are behind it, so each one can be overridden per
 * install from the module's own settings page.
 *
 * Read through `effectiveRules` and never cached: the user can change them
 * between two ticks, and a sweep that used yesterday's parallelism would be
 * confusing rather than fast.
 */
import type { ModuleContext } from '@shared/modules'

export type UnitScope = 'watched' | 'running' | 'all'

export interface FleetRules {
  /** How many ssh sessions the jump host opens at once (`xargs -P`). */
  maxParallel: number
  /** ssh ConnectTimeout: how long a machine that is not there costs. */
  connectTimeoutSec: number
  /** `timeout` around one ssh, so a machine that answers but hangs still ends. */
  perHostTimeoutSec: number
  /** `timeoutMs` for the whole fan-out command on the shared connection. */
  sweepTimeoutSec: number
  /** ssh ControlPersist: how long a reused connection is kept warm. 0 disables multiplexing. */
  controlPersistSec: number
  /** Whether ssh verifies host keys. Off suits a lab subnet, on suits production. */
  strictHostKey: boolean
  /** Refuse to enumerate a rule covering more addresses than this. */
  maxHosts: number
  /** Which units a sweep asks each machine for. */
  unitScope: UnitScope
  /** Cap on the unit lines one machine may return. */
  maxUnitsPerHost: number
  /** How many chips one card carries; the rest are only in the drawer. */
  cardUnits: number
  /** Warn once a bulk action would touch this many machine/unit pairs. */
  bulkWarnAt: number
  /** Warn once an install would touch this many machines. */
  installWarnAt: number
  /** Whether a critical watched unit being down turns the card red instead of amber. */
  criticalDownIsRed: boolean
}

export const DEFAULT_RULES: FleetRules = {
  maxParallel: 16,
  connectTimeoutSec: 5,
  perHostTimeoutSec: 20,
  sweepTimeoutSec: 180,
  controlPersistSec: 60,
  strictHostKey: false,
  maxHosts: 256,
  unitScope: 'running',
  maxUnitsPerHost: 120,
  cardUnits: 12,
  bulkWarnAt: 25,
  installWarnAt: 10,
  criticalDownIsRed: true
}

/** What each numeric rule may be set to. A check reports anything outside as an error. */
export const RULE_BOUNDS: Record<string, { min: number; max: number; label: string }> = {
  maxParallel: { min: 1, max: 64, label: 'Machines contacted at once' },
  connectTimeoutSec: { min: 1, max: 30, label: 'SSH connect timeout (s)' },
  perHostTimeoutSec: { min: 5, max: 300, label: 'Per-machine timeout (s)' },
  sweepTimeoutSec: { min: 30, max: 900, label: 'Whole sweep timeout (s)' },
  controlPersistSec: { min: 0, max: 600, label: 'Keep SSH connections warm (s)' },
  maxHosts: { min: 1, max: 4096, label: 'Largest address range' },
  maxUnitsPerHost: { min: 10, max: 500, label: 'Unit lines per machine' },
  cardUnits: { min: 4, max: 40, label: 'Chips per card' },
  bulkWarnAt: { min: 1, max: 1000, label: 'Warn on bulk action size' },
  installWarnAt: { min: 1, max: 1000, label: 'Warn on install size' }
}

/** Extreme but legal values, worth a warning rather than a refusal. */
export const RULE_UNUSUAL: Record<string, (value: number) => string | null> = {
  maxParallel: (v) =>
    v > 32 ? 'More simultaneous SSH sessions than a small jump host usually has file descriptors for.' : null,
  connectTimeoutSec: (v) =>
    v > 10 ? 'Every address that is not there costs this long, multiplied by the range size.' : null,
  perHostTimeoutSec: (v) => (v < 10 ? 'A cold SSH handshake plus systemctl often takes longer than this.' : null),
  sweepTimeoutSec: (v) =>
    v < 60 ? 'A range of any size will not finish inside this, and the sweep will be cut off.' : null,
  controlPersistSec: (v) =>
    v === 0 ? 'Every sweep will pay a full SSH handshake per machine again.' : null,
  maxHosts: (v) => (v > 1024 ? 'That many machines per rule will make one sweep very long.' : null)
}

const UNIT_SCOPES: UnitScope[] = ['watched', 'running', 'all']

/**
 * The rules in force: the defaults with whatever the user overrode on top. A
 * stored value of the wrong type is ignored rather than trusted, since this
 * comes from a file the app does not otherwise validate.
 */
export function effectiveRules(ctx: ModuleContext): FleetRules {
  const out = { ...DEFAULT_RULES }
  const raw = ctx.configGet()
  const overrides = (raw as { rules?: unknown } | null)?.rules
  if (typeof overrides !== 'object' || overrides === null) return out
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(key in DEFAULT_RULES)) continue
    if (key === 'unitScope') {
      if (UNIT_SCOPES.includes(value as UnitScope)) out.unitScope = value as UnitScope
      continue
    }
    const expected = typeof DEFAULT_RULES[key as keyof FleetRules]
    if (typeof value !== expected) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    ;(out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}

/** Which rules the user has actually overridden, for the settings page. */
export function overriddenRuleKeys(ctx: ModuleContext): Set<string> {
  const raw = ctx.configGet()
  const overrides = (raw as { rules?: unknown } | null)?.rules
  if (typeof overrides !== 'object' || overrides === null) return new Set()
  const out = new Set<string>()
  for (const key of Object.keys(DEFAULT_RULES)) {
    if ((overrides as Record<string, unknown>)[key] !== undefined) out.add(key)
  }
  return out
}
