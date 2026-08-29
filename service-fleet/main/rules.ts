/**
 * The limits every sweep, every fan-out and every check measures against. They
 * are defaults, not constants: how hard you may lean on one jump host depends
 * on the machine and on how many machines are behind it, so each one can be
 * overridden per install from the module's own settings page.
 *
 * Read through `effectiveRules` and never cached: the user can change them
 * between two ticks, and a sweep that used yesterday's parallelism would be
 * confusing rather than fast.
 */
import type { ModuleContext } from '@shared/modules'

export interface FleetRules {
  /** How many ssh sessions or curl requests the jump host opens at once (`xargs -P`). */
  maxParallel: number
  /** Connect timeout, for both ssh and curl: what a machine that is not there costs. */
  connectTimeoutSec: number
  /** Per-request ceiling, so a machine that answers but hangs still ends. */
  perHostTimeoutSec: number
  /** `timeoutMs` for a whole SSH fan-out on the shared connection. */
  sweepTimeoutSec: number
  /** ssh ControlPersist: how long a reused connection is kept warm. 0 disables multiplexing. */
  controlPersistSec: number
  /** Whether ssh verifies host keys. Off suits a lab subnet, on suits production. */
  strictHostKey: boolean
  /** Refuse to enumerate a rule covering more addresses than this. */
  maxHosts: number

  /** Port every agent is expected on. One number, because the installer fixes it. */
  agentPort: number
  /** How many chips one fleet card carries; the rest are only in the drawer. */
  cardInstances: number
  /** Warn once a bulk action would touch this many machines. */
  bulkWarnAt: number
  /** Warn once installing the agent would touch this many machines. */
  installWarnAt: number

  /** How often telemetry is pulled from each agent, in minutes. */
  telemetryEveryMin: number
  /** How far back a first pull reaches when a machine has no cursor yet. */
  telemetryBackfillDays: number
  /** Cap on user-authored templates, so the config document stays inside its grant. */
  maxTemplates: number
  /** Whether an instance missing only an optional unit turns its card amber. */
  degradedIsAmber: boolean
}

export const DEFAULT_RULES: FleetRules = {
  maxParallel: 16,
  connectTimeoutSec: 5,
  perHostTimeoutSec: 20,
  sweepTimeoutSec: 180,
  controlPersistSec: 60,
  strictHostKey: false,
  maxHosts: 256,

  agentPort: 8741,
  cardInstances: 12,
  bulkWarnAt: 25,
  installWarnAt: 10,

  telemetryEveryMin: 30,
  telemetryBackfillDays: 30,
  maxTemplates: 40,
  degradedIsAmber: true
}

/** What each numeric rule may be set to. A check reports anything outside as an error. */
export const RULE_BOUNDS: Record<string, { min: number; max: number; label: string }> = {
  maxParallel: { min: 1, max: 64, label: 'Machines contacted at once' },
  connectTimeoutSec: { min: 1, max: 30, label: 'Connect timeout (s)' },
  perHostTimeoutSec: { min: 5, max: 300, label: 'Per-machine timeout (s)' },
  sweepTimeoutSec: { min: 30, max: 900, label: 'Whole sweep timeout (s)' },
  controlPersistSec: { min: 0, max: 600, label: 'Keep SSH connections warm (s)' },
  maxHosts: { min: 1, max: 4096, label: 'Largest address range' },
  agentPort: { min: 1, max: 65535, label: 'Agent port' },
  cardInstances: { min: 4, max: 40, label: 'Chips per card' },
  bulkWarnAt: { min: 1, max: 1000, label: 'Warn on bulk action size' },
  installWarnAt: { min: 1, max: 1000, label: 'Warn on agent install size' },
  telemetryEveryMin: { min: 5, max: 1440, label: 'Pull telemetry every (min)' },
  telemetryBackfillDays: { min: 1, max: 400, label: 'First-pull backfill (days)' },
  maxTemplates: { min: 1, max: 200, label: 'User templates kept' }
}

/** Extreme but legal values, worth a warning rather than a refusal. */
export const RULE_UNUSUAL: Record<string, (value: number) => string | null> = {
  maxParallel: (v) =>
    v > 32 ? 'More simultaneous sessions than a small jump host usually has file descriptors for.' : null,
  connectTimeoutSec: (v) =>
    v > 10 ? 'Every address that is not there costs this long, multiplied by the range size.' : null,
  perHostTimeoutSec: (v) =>
    v < 10 ? 'A cold SSH handshake plus a probe often takes longer than this.' : null,
  sweepTimeoutSec: (v) =>
    v < 60 ? 'A range of any size will not finish inside this, and the sweep will be cut off.' : null,
  controlPersistSec: (v) =>
    v === 0 ? 'Every sweep will pay a full SSH handshake per machine again.' : null,
  maxHosts: (v) => (v > 1024 ? 'That many machines per rule will make one sweep very long.' : null),
  agentPort: (v) =>
    v !== DEFAULT_RULES.agentPort
      ? `The installer always binds ${DEFAULT_RULES.agentPort}. Change this only if something in front of the agent moves it.`
      : null,
  telemetryEveryMin: (v) =>
    v < 15
      ? 'Agents keep their own daily rows, so pulling more often than every quarter hour buys nothing.'
      : null,
  telemetryBackfillDays: (v) =>
    v > 120
      ? 'A first pull will fetch that many days from every agent at once, which is a lot of rows for one tick.'
      : null
}

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
    const expected = typeof DEFAULT_RULES[key as keyof FleetRules]
    if (typeof value !== expected) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    ;(out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}
