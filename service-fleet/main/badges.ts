/**
 * One colour per meaning, for every chip this module renders.
 *
 * Status words are produced in four places - an agent is `ready`, an instance
 * is `degraded`, a machine is `no-agent`, a job step is `warning` - and the
 * point of this table is not decoration: it is that `failed` is the same red on
 * the fleet wall, in the instances table and in job history, so a colour means
 * one thing everywhere and a user can scan a page without reading it.
 *
 * The hex is deliberate. Chips are data, not theme tokens - they travel through
 * a stream and have to survive a theme switch - so this picks from the same
 * twelve swatches the app's own colour field offers (`FORM_COLOR_SWATCHES`).
 *
 * Copied from the OpenWRT module rather than shared, because a module may only
 * import its own files and `@shared/*`, and the app has no chip vocabulary of
 * its own to reach for.
 */
import type { ValueBadge } from '@shared/module-ui'

export const BADGE = {
  /** Working, finished, or otherwise nothing to do. */
  good: '#22c55e',
  /** Doing something right now, and expected to stop. */
  busy: '#3b82f6',
  /** Works, but somebody should look. */
  warn: '#f59e0b',
  /** Broken. */
  bad: '#ef4444',
  /** Reachable, but the agent this module needs is not there. */
  missing: '#f97316'
} as const

/** The vocabulary `statusCards` tints its rows and chips with. */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'unknown'

export interface StatusChip {
  label: string
  status: StatusTone
  /** Set on anything not `ok`, so a card's "pinned only" switch shows faults. */
  pinned: boolean
}

/**
 * Every status word this module puts in front of a user, and nothing else. A
 * word that is not here renders as a neutral chip, which is the right answer
 * for `stopped`, `absent`, `skipped`, `cancelled` and `unknown` - states that
 * are neither healthy nor wrong - and a visible bug for anything that was meant
 * to carry a colour.
 */
const STATUS_COLOR: Readonly<Record<string, string>> = {
  // Agents
  ready: BADGE.good,
  online: BADGE.good,
  ok: BADGE.good,
  done: BADGE.good,
  running: BADGE.good,

  installing: BADGE.busy,
  pending: BADGE.busy,
  checking: BADGE.busy,
  restarting: BADGE.busy,

  degraded: BADGE.warn,
  warning: BADGE.warn,
  outdated: BADGE.warn,
  partial: BADGE.warn,
  untrusted: BADGE.warn,

  failed: BADGE.bad,
  error: BADGE.bad,
  offline: BADGE.bad,
  unreachable: BADGE.bad,
  unhealthy: BADGE.bad,

  // Reachable over SSH, and the agent is simply not installed. A different
  // failure from `unreachable`, and the one the user can act on in one click.
  'no-agent': BADGE.missing,
  missing: BADGE.missing
}

/** One chip. Pass a colour for a word whose meaning is local to the caller. */
export function badge(label: string, color?: string): ValueBadge {
  return color ? { label, color } : { label }
}

/** The chip for a status word; empty for an empty status, so a cell stays blank. */
export function statusBadges(status: unknown): ValueBadge[] {
  const label = typeof status === 'string' ? status.trim() : ''
  if (!label) return []
  return [badge(label, STATUS_COLOR[label])]
}

export interface BadgeCount {
  label: string
  count: number
  color?: string
}

/**
 * `3 running`, `1 failed`. A count of zero is left out rather than printed as
 * `0 running`: the chips exist to say what is worth looking at, and a row of
 * zeroes says nothing while costing the width the non-zero ones need.
 */
export function countBadges(parts: readonly BadgeCount[]): ValueBadge[] {
  return parts
    .filter((part) => part.count > 0)
    .map((part) => badge(`${part.count} ${part.label}`, part.color))
}

/** The same table read as a tone, for the blocks that tint rather than colour. */
export function statusTone(status: unknown): StatusTone {
  const color = typeof status === 'string' ? STATUS_COLOR[status] : undefined
  if (color === BADGE.good) return 'ok'
  if (color === BADGE.bad || color === BADGE.missing) return 'bad'
  if (color === BADGE.warn) return 'warn'
  return 'unknown'
}

/** A `statusCards` chip, pinned whenever it is not the healthy case. */
export function chip(label: string, status: StatusTone): StatusChip {
  return { label, status, pinned: status !== 'ok' }
}
