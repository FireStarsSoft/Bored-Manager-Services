/**
 * Turning one sweep into what the pages show: which addresses are machines,
 * what colour each card is, and the rows behind the tables.
 *
 * The rule that decides whether an address is a machine at all is the important
 * one. An address inside a `/24` that nothing answered from is a **candidate**,
 * not a machine: it is swept, and it stays out of the roster. Without that,
 * watching one subnet would draw 249 red cards for addresses nothing has ever
 * lived at, and the five machines that matter would be lost among them.
 *
 * Three things earn a card:
 *
 * - an answer that proves a machine is there, which includes one that **refuses
 *   the login** or presents an unexpected host key - "found it, cannot get in"
 *   is exactly the case worth colouring red;
 * - being named by the user as a single address (`pinned`), so a machine that
 *   has never once answered is still visibly down rather than absent;
 * - having earned a card before.
 *
 * Once an address has earned a card it keeps it, so a machine that stops
 * answering turns red rather than disappearing - which is the whole point of
 * watching it.
 */
import { resolveCredential, ruleCovers, type TargetRule, type WatchedUnit } from './config'
import { compareIp, matchesGlob } from './net'
import type { FleetRules } from './rules'
import type { HostRecord, HostStore, Reachability } from './store'
import { canControl, type HostFacts, type UnitState } from './units'

export type CardStatus = 'ok' | 'warn' | 'bad' | 'unknown'

export interface SweepEntry {
  ip: string
  cred: TargetRule
  reach: Reachability
  reachMessage: string
  facts: HostFacts | null
}

/** A watched unit resolved against one machine: `state` is null when the machine was not reached. */
export interface WatchedState {
  def: WatchedUnit
  state: UnitState | null
}

export interface HostLive {
  ip: string
  cred: TargetRule
  reach: Reachability
  reachMessage: string
  facts: HostFacts | null
  watched: WatchedState[]
  status: CardStatus
  summary: string
  note: string
  /** One line per thing wrong, for the note and the drawer. */
  problems: string[]
}

export interface Chip {
  label: string
  status: CardStatus
  pinned: boolean
}

export interface HostCard {
  id: string
  ip: string
  status: CardStatus
  summary: string
  note: string
  services: Chip[]
  /** So the card's drawer can open a shell without a second round trip. */
  username: string
  port: number
}

export interface FleetCounts {
  total: number
  online: number
  offline: number
  degraded: number
  unknown: number
  unitsRunning: number
  unitsFailed: number
  watchedDown: number
}

export interface HostsPayload {
  t: number
  hosts: HostCard[]
  counts: FleetCounts
}

const STATUS_WEIGHT: Record<CardStatus, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 }

function worst(a: CardStatus, b: CardStatus): CardStatus {
  return STATUS_WEIGHT[a] <= STATUS_WEIGHT[b] ? a : b
}

/**
 * Whether the answer proves a machine lives at this address, which is what
 * decides between "nothing is here" and "something is here and I cannot get
 * in". A refused login, an unknown host key and a closed SSH port all came
 * *from* a machine; a timeout or no route came from nowhere.
 */
function provesAMachine(reach: Reachability): boolean {
  return reach === 'ok' || reach === 'auth' || reach === 'hostkey' || reach === 'refused'
}

/** Which watched units a machine is supposed to be running. */
export function watchedFor(
  watched: readonly WatchedUnit[],
  ip: string,
  label: string | undefined
): WatchedUnit[] {
  return watched.filter((w) => matchesGlob(w.appliesTo, [ip, label]))
}

/** How a single unit's state reads as a colour. `watched` units are held to a higher standard. */
export function unitStatus(state: UnitState | null, watchedUnit: boolean, critical: boolean): CardStatus {
  if (!state) return 'unknown'
  if (state.load === 'not-found') return watchedUnit && critical ? 'bad' : watchedUnit ? 'warn' : 'unknown'
  if (state.load === 'masked' || state.fileState === 'masked') return watchedUnit ? 'warn' : 'unknown'
  if (state.active === 'failed' || state.sub === 'failed') return 'bad'
  if (state.active === 'active') return 'ok'
  if (state.active === 'activating' || state.active === 'deactivating') return 'warn'
  return watchedUnit ? 'warn' : 'unknown'
}

/** One word for what a unit is doing, in the vocabulary a person would use. */
export function healthLabel(state: UnitState | null): string {
  if (!state) return 'unknown'
  if (state.load === 'not-found') return 'not installed'
  if (state.load === 'masked' || state.fileState === 'masked') return 'masked'
  if (state.active === 'failed' || state.sub === 'failed') return 'failed'
  if (state.active === 'active') return state.sub === 'running' ? 'running' : state.sub || 'active'
  if (state.active === 'activating') return 'starting'
  if (state.active === 'deactivating') return 'stopping'
  return state.active || 'stopped'
}

/** Short enough for a chip: no `.service`, and the state only when it is not simply running. */
export function chipLabel(state: UnitState | null, unit: string): string {
  const name = unit.replace(/\.service$/, '')
  const health = healthLabel(state)
  return health === 'running' || health === 'unknown' ? name : `${name} (${health})`
}

function relative(from: number | null): string {
  if (!from) return 'never'
  const sec = Math.max(0, Math.round((Date.now() - from) / 1000))
  if (sec < 90) return `${sec}s ago`
  if (sec < 5400) return `${Math.round(sec / 60)}m ago`
  if (sec < 172800) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

/**
 * Everything the roster knows right now. The store half is on disk; the live
 * half - facts and unit lists - is memory only and starts empty after a
 * reconnect, which is why a card can legitimately be grey.
 */
export class Roster {
  private live = new Map<string, HostLive>()

  constructor(private store: HostStore) {}

  reset(): void {
    this.live.clear()
    this.store.reset()
  }

  get size(): number {
    return this.live.size
  }

  liveFor(ip: string): HostLive | undefined {
    return this.live.get(ip)
  }

  records(): Record<string, HostRecord> {
    return this.store.read().hosts
  }

  /**
   * Fold one sweep in, replacing what was live before: the sweep covered every
   * configured address, so anything missing from it is no longer configured.
   *
   * Writes to disk only when a record actually changed, so a sweep every two
   * minutes does not mean a file write every two minutes.
   */
  apply(entries: readonly SweepEntry[], watched: readonly WatchedUnit[], rules: FleetRules): void {
    const nextLive = new Map<string, HostLive>()
    const dirty = this.mergeInto(nextLive, entries, watched, rules)
    // The document is the store's own cached object, so the roster is already up
    // to date in memory either way; the disk only hears about it when something
    // a person would notice changed.
    if (dirty) this.store.persist()
    this.live = nextLive
  }

  /**
   * Fold in one machine that was re-read on its own, after an action or a manual
   * probe, leaving every other card alone.
   */
  applyOne(entry: SweepEntry, watched: readonly WatchedUnit[], rules: FleetRules): void {
    if (this.mergeInto(this.live, [entry], watched, rules)) this.store.persist()
  }

  private mergeInto(
    into: Map<string, HostLive>,
    entries: readonly SweepEntry[],
    watched: readonly WatchedUnit[],
    rules: FleetRules
  ): boolean {
    const now = Date.now()
    const data = this.store.read()
    let dirty = false
    for (const entry of entries) {
      const existing = data.hosts[entry.ip]
      const pinned = entry.cred.kind === 'host'
      const earnsRecord = provesAMachine(entry.reach) || pinned || existing != null
      if (!earnsRecord) continue
      const record: HostRecord = {
        ip: entry.ip,
        label: entry.cred.label,
        hostname: entry.facts?.hostname || existing?.hostname,
        os: entry.facts?.os || existing?.os,
        kernel: entry.facts?.kernel || existing?.kernel,
        firstSeen: existing?.firstSeen || now,
        lastSeen: entry.reach === 'ok' ? now : (existing?.lastSeen ?? null),
        lastProbeAt: now,
        reach: entry.reach,
        reachNote: entry.reachMessage,
        pinned: pinned || existing?.pinned === true
      }
      // lastProbeAt moves on every sweep and would make every sweep a write, so
      // it is not part of what "changed" means.
      const before = existing ? { ...existing, lastProbeAt: 0 } : null
      const after = { ...record, lastProbeAt: 0 }
      if (!before || JSON.stringify(before) !== JSON.stringify(after)) dirty = true
      data.hosts[entry.ip] = record
      into.set(entry.ip, this.buildLive(entry, record, watched, rules))
    }
    return dirty
  }

  /** Drop a machine the user does not want to see any more. */
  forget(ip: string): boolean {
    const data = this.store.read()
    if (!data.hosts[ip]) return false
    this.store.update((d) => {
      delete d.hosts[ip]
    })
    this.live.delete(ip)
    return true
  }

  /** Records for addresses no rule covers any more, after the user edited the rules. */
  pruneUnclaimed(targets: readonly TargetRule[]): number {
    const data = this.store.read()
    const orphans = Object.keys(data.hosts).filter((ip) => !targets.some((rule) => ruleCovers(rule, ip)))
    if (orphans.length === 0) return 0
    this.store.update((d) => {
      for (const ip of orphans) delete d.hosts[ip]
    })
    for (const ip of orphans) this.live.delete(ip)
    return orphans.length
  }

  private buildLive(
    entry: SweepEntry,
    record: HostRecord,
    watched: readonly WatchedUnit[],
    rules: FleetRules
  ): HostLive {
    const defs = watchedFor(watched, entry.ip, record.label)
    const shown = entry.facts?.watched ?? []
    const states: WatchedState[] = defs.map((def) => ({
      def,
      state: shown.find((s) => s.unit === def.unit) ?? null
    }))
    const problems: string[] = []
    let status: CardStatus

    if (entry.reach !== 'ok') {
      status = 'bad'
      problems.push(entry.reachMessage)
    } else if (!entry.facts) {
      status = 'unknown'
      problems.push('Connected, but the sweep returned nothing readable.')
    } else if (!entry.facts.systemd) {
      status = 'warn'
      problems.push('No systemd on this machine, so its services cannot be listed or controlled from here.')
    } else {
      status = 'ok'
      for (const { def, state } of states) {
        const unitState = unitStatus(state, true, def.severity === 'critical')
        if (unitState === 'ok') continue
        const critical = def.severity === 'critical'
        const level: CardStatus = critical && rules.criticalDownIsRed ? 'bad' : 'warn'
        status = worst(status, level)
        problems.push(`${chipLabel(state, def.unit)}${critical ? ' - marked critical' : ''}`)
      }
      if (states.length > 0 && !canControl(entry.facts, entry.cred.sudo)) {
        status = worst(status, 'warn')
        problems.push(
          entry.cred.sudo === 'none'
            ? 'Read-only: this address is set to use no sudo and the account is not root.'
            : 'Read-only: sudo needs a password here and none is set for this address.'
        )
      }
      if (entry.facts.truncated) {
        problems.push(`Only the first ${rules.maxUnitsPerHost} service lines were read from this machine.`)
      }
    }

    const running = entry.facts?.units.filter((u) => u.active === 'active').length ?? 0
    const watchedOk = states.filter(({ def, state }) => unitStatus(state, true, def.severity === 'critical') === 'ok')
      .length
    const summary =
      entry.reach !== 'ok'
        ? relative(record.lastSeen) === 'never'
          ? 'never reached'
          : `last seen ${relative(record.lastSeen)}`
        : states.length > 0
          ? `${watchedOk}/${states.length} watched`
          : `${running} running`

    const noteParts = [entry.reachMessage]
    if (entry.reach === 'ok') {
      const where = [record.hostname, entry.facts?.os].filter((x) => x).join(' - ')
      if (where) noteParts.push(where)
    } else {
      noteParts.push(`Last reached ${relative(record.lastSeen)}.`)
    }
    if (problems.length && entry.reach === 'ok') noteParts.push(...problems)

    return {
      ip: entry.ip,
      cred: entry.cred,
      reach: entry.reach,
      reachMessage: entry.reachMessage,
      facts: entry.facts,
      watched: states,
      status,
      summary,
      note: noteParts.filter((p) => p && p.trim() !== '').join(' '),
      problems
    }
  }

  /** Every unit known for one machine, watched ones first, one entry per unit name. */
  unitsFor(ip: string): Array<{ state: UnitState; watched: boolean; severity: 'critical' | 'normal' }> {
    const live = this.live.get(ip)
    if (!live) return []
    const out: Array<{ state: UnitState; watched: boolean; severity: 'critical' | 'normal' }> = []
    const seen = new Set<string>()
    for (const { def, state } of live.watched) {
      seen.add(def.unit)
      out.push({
        state: state ?? {
          unit: def.unit,
          load: live.facts ? 'not-found' : '',
          active: '',
          sub: '',
          fileState: '',
          description: def.label ?? ''
        },
        watched: true,
        severity: def.severity
      })
    }
    for (const state of live.facts?.units ?? []) {
      if (seen.has(state.unit)) continue
      seen.add(state.unit)
      out.push({ state, watched: false, severity: 'normal' })
    }
    return out
  }

  /** The `hosts` stream: only what a card draws, capped, so the payload stays small. */
  cards(rules: FleetRules): HostsPayload {
    const hosts: HostCard[] = []
    const counts: FleetCounts = {
      total: 0,
      online: 0,
      offline: 0,
      degraded: 0,
      unknown: 0,
      unitsRunning: 0,
      unitsFailed: 0,
      watchedDown: 0
    }
    for (const live of this.live.values()) {
      counts.total++
      if (live.status === 'ok') counts.online++
      else if (live.status === 'unknown') counts.unknown++
      else if (live.reach !== 'ok') counts.offline++
      else counts.degraded++

      const services: Chip[] = []
      for (const { def, state } of live.watched) {
        const status = unitStatus(state, true, def.severity === 'critical')
        if (status !== 'ok') counts.watchedDown++
        services.push({ label: chipLabel(state, def.unit), status, pinned: true })
      }
      const watchedNames = new Set(live.watched.map((w) => w.def.unit))
      for (const state of live.facts?.units ?? []) {
        if (state.active === 'active') counts.unitsRunning++
        if (state.active === 'failed' || state.sub === 'failed') counts.unitsFailed++
        if (watchedNames.has(state.unit)) continue
        if (services.length >= rules.cardUnits) continue
        services.push({ label: chipLabel(state, state.unit), status: unitStatus(state, false, false), pinned: false })
      }
      hosts.push({
        id: live.ip,
        ip: live.ip,
        status: live.status,
        summary: live.summary,
        note: live.note,
        services,
        username: live.cred.username,
        port: live.cred.port
      })
    }
    hosts.sort((a, b) => STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status] || compareIp(a.ip, b.ip))
    return { t: Date.now(), hosts, counts }
  }

  /** The Machines page: one row per address in the roster. */
  hostRows(): Array<Record<string, unknown>> {
    const records = this.store.read().hosts
    const rows = Object.values(records).map((record) => {
      const live = this.live.get(record.ip)
      const watchedTotal = live?.watched.length ?? 0
      const watchedOk =
        live?.watched.filter(({ def, state }) => unitStatus(state, true, def.severity === 'critical') === 'ok')
          .length ?? 0
      return {
        id: record.ip,
        ip: record.ip,
        label: record.label ?? '',
        hostname: record.hostname ?? '',
        os: record.os ?? '',
        kernel: record.kernel ?? '',
        status: live?.status ?? 'unknown',
        reach: record.reach,
        note: live?.note ?? record.reachNote,
        watched: watchedTotal ? `${watchedOk}/${watchedTotal}` : '—',
        running: live?.facts?.units.filter((u) => u.active === 'active').length ?? 0,
        failed: live?.facts?.units.filter((u) => u.active === 'failed' || u.sub === 'failed').length ?? 0,
        lastSeen: record.lastSeen ?? 0,
        pinned: record.pinned ? 'yes' : '',
        username: live?.cred.username ?? '',
        port: live?.cred.port ?? 22,
        sudo: live?.cred.sudo ?? 'none'
      }
    })
    rows.sort((a, b) => compareIp(String(a.ip), String(b.ip)))
    return rows
  }

  /** The Services page: one row per machine and unit, so a bulk action can tick across machines. */
  unitRows(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const live of this.live.values()) {
      for (const { state, watched, severity } of this.unitsFor(live.ip)) {
        out.push({
          id: `${live.ip}|${state.unit}`,
          ip: live.ip,
          label: live.cred.label ?? '',
          unit: state.unit,
          watched: watched ? 'yes' : '',
          severity: watched ? severity : '',
          status: unitStatus(state, watched, severity === 'critical'),
          health: healthLabel(state),
          load: state.load,
          active: state.active,
          sub: state.sub,
          fileState: state.fileState,
          description: state.description
        })
      }
    }
    out.sort(
      (a, b) =>
        STATUS_WEIGHT[a.status as CardStatus] - STATUS_WEIGHT[b.status as CardStatus] ||
        compareIp(String(a.ip), String(b.ip)) ||
        String(a.unit).localeCompare(String(b.unit))
    )
    return out
  }

  /** The drawer's key/value panel for one machine. */
  inspect(ip: string): Record<string, unknown> | null {
    const record = this.store.read().hosts[ip]
    const live = this.live.get(ip)
    if (!record && !live) return null
    const facts = live?.facts
    return {
      ip,
      label: record?.label ?? live?.cred.label ?? '',
      hostname: record?.hostname ?? '',
      os: record?.os ?? '',
      kernel: record?.kernel ?? '',
      status: live?.status ?? 'unknown',
      reach: record?.reach ?? 'unknown',
      note: live?.note ?? record?.reachNote ?? '',
      username: live?.cred.username ?? '',
      port: live?.cred.port ?? 22,
      auth: live?.cred.auth ?? '',
      sudo: live?.cred.sudo ?? 'none',
      controllable: facts ? (canControl(facts, live?.cred.sudo ?? 'none') ? 'yes' : 'no') : 'unknown',
      packageManager: facts?.pkg || 'unknown',
      uptimeSec: facts?.uptimeSec ?? 0,
      running: facts?.units.filter((u) => u.active === 'active').length ?? 0,
      failed: facts?.units.filter((u) => u.active === 'failed' || u.sub === 'failed').length ?? 0,
      firstSeen: record?.firstSeen ?? 0,
      lastSeen: record?.lastSeen ?? 0,
      lastProbeAt: record?.lastProbeAt ?? 0
    }
  }

  /** Every machine currently in the roster that a rule still reaches, for a bulk action. */
  controllable(targets: readonly TargetRule[]): HostLive[] {
    const out: HostLive[] = []
    for (const live of this.live.values()) {
      if (resolveCredential(live.ip, targets)) out.push(live)
    }
    return out.sort((a, b) => compareIp(a.ip, b.ip))
  }
}
