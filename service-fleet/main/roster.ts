/**
 * Which addresses count as machines, what colour each card is, and the rows
 * behind every table.
 *
 * The rule that decides whether an address is a machine at all is the important
 * one, and it is unchanged from when this module watched systemd units. An
 * address inside a `/24` that nothing answered from is a **candidate**, not a
 * machine: it is swept, and it stays out of the roster. Without that, watching
 * one subnet would draw 249 red cards for addresses nothing has ever lived at,
 * and the five machines that matter would be lost among them.
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
 *
 * What changed is what a card *says*. It used to be systemd units; it is now
 * the agent and whatever the agent is running.
 */
import { chip, countBadges, statusBadges, statusTone, BADGE, type StatusChip } from './badges'
import { resolveCredential, ruleCovers, type TargetRule } from './config'
import { compareIp } from './net'
import type { FleetRules } from './rules'
import type { HostRecord, HostStore, Reachability } from './store'
import type { HostFacts } from './hostprobe'
import { agentUsable, type AgentInfo } from './agent/types'

export type CardStatus = 'ok' | 'warn' | 'bad' | 'unknown'

export interface SweepEntry {
  ip: string
  cred: TargetRule
  reach: Reachability
  reachMessage: string
  /** Who the machine says it is, from the SSH probe. Null when it did not answer. */
  facts: HostFacts | null
  /** What the agent said, or null when it was never asked or never answered. */
  agent: AgentInfo | null
}

export interface HostLive {
  ip: string
  cred: TargetRule
  reach: Reachability
  reachMessage: string
  agent: AgentInfo | null
  status: CardStatus
  summary: string
  note: string
  /** One line per thing wrong, for the note and the drawer. */
  problems: string[]
}

export interface HostCard {
  id: string
  ip: string
  status: CardStatus
  summary: string
  note: string
  services: StatusChip[]
  /** So the card's drawer can open a shell without a second round trip. */
  username: string
  port: number
}

export interface FleetCounts {
  total: number
  /** Agents answering, at any version. */
  ready: number
  /** Reachable over SSH with no agent - the one the user can fix in a click. */
  noAgent: number
  /** Nothing answered at all. */
  unreachable: number
  unknown: number
  instancesRunning: number
  instancesDegraded: number
  instancesFailed: number
  /** Agents whose own probe says the machine has no internet. */
  hostsOffline: number
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

/** How one instance's state reads as a colour. */
export function instanceStatus(state: string, degradedIsAmber: boolean): CardStatus {
  switch (state) {
    case 'running':
      return 'ok'
    case 'degraded':
      return degradedIsAmber ? 'warn' : 'ok'
    case 'failed':
      return 'bad'
    case 'stopped':
    case 'absent':
      return 'warn'
    default:
      return 'unknown'
  }
}

/** How one agent's state reads as a colour. */
export function agentStatus(info: AgentInfo | null, reach: Reachability): CardStatus {
  if (!info) return reach === 'ok' ? 'unknown' : 'bad'
  switch (info.state) {
    case 'ready':
      return 'ok'
    case 'outdated':
      return 'warn'
    case 'none':
    case 'untrusted':
      // Reachable, and this module cannot use it. Amber rather than red: the
      // machine is fine, the fleet simply does not manage it yet.
      return 'warn'
    default:
      return 'bad'
  }
}

export class Roster {
  private live = new Map<string, HostLive>()
  /**
   * Bumped whenever `live` or the stored records change. The table payloads are
   * built from nothing else, so between two changes they are the same answer -
   * and they are asked for on every fast tick, which on a /24 of machines each
   * running several instances means thousands of rows rebuilt and re-sorted a
   * few times a minute for a table that did not move.
   */
  private generation = 0
  private rows: {
    generation: number
    hosts?: Array<Record<string, unknown>>
    instances?: Array<Record<string, unknown>>
    net?: Array<Record<string, unknown>>
  } = { generation: -1 }

  constructor(private store: HostStore) {}

  reset(): void {
    this.live.clear()
    this.store.reset()
    this.generation++
  }

  /** Write what the roster holds in memory, whether or not `mergeInto` called it a change. */
  flush(): void {
    this.store.persist()
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

  /** Every machine with a usable agent, for a fan-out that only agents can serve. */
  agents(): HostLive[] {
    return [...this.live.values()].filter((live) => agentUsable(live.agent))
  }

  /**
   * Fold one sweep in. A full sweep replaces what was live before - it covered
   * every configured address, so anything missing from it is no longer
   * configured. `partial` (a sweep cut short by cancel or a module going away)
   * did not cover every address, so it merges onto whatever was already live
   * instead - otherwise every address not yet reached that round would vanish
   * from the wall and from bulk targeting until the next full sweep.
   */
  apply(entries: readonly SweepEntry[], rules: FleetRules, opts?: { partial?: boolean }): void {
    const nextLive = opts?.partial ? new Map(this.live) : new Map<string, HostLive>()
    const dirty = this.mergeInto(nextLive, entries, rules)
    if (dirty) this.store.persist()
    this.live = nextLive
    this.generation++
  }

  /** Fold in one machine re-read on its own, leaving every other card alone. */
  applyOne(entry: SweepEntry, rules: FleetRules): void {
    if (this.mergeInto(this.live, [entry], rules)) this.store.persist()
    this.generation++
  }

  private mergeInto(
    into: Map<string, HostLive>,
    entries: readonly SweepEntry[],
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
        pinned: pinned || existing?.pinned === true,
        agentToken: existing?.agentToken,
        agentState: entry.agent?.state ?? existing?.agentState,
        agentVersion: entry.agent?.version ?? existing?.agentVersion,
        agentCheckedAt: entry.agent ? now : (existing?.agentCheckedAt ?? null),
        telemetryCursor: existing?.telemetryCursor ?? null
      }
      // lastProbeAt moves on every sweep, and lastSeen on every sweep that
      // reaches the machine - a fleet that is up would mean a disk write every
      // two minutes for every machine in it, which is exactly what the module
      // rules say not to do. Neither is part of what "changed" means; both are
      // in the record either way, so the next real change - or dispose(),
      // which flushes - writes the current values out with it.
      const strip = (value: HostRecord): Record<string, unknown> => ({
        ...value,
        lastProbeAt: 0,
        lastSeen: 0,
        agentCheckedAt: 0
      })
      if (!existing || JSON.stringify(strip(existing)) !== JSON.stringify(strip(record))) dirty = true
      data.hosts[entry.ip] = record
      into.set(entry.ip, this.buildLive(entry, record, rules))
    }
    return dirty
  }

  private buildLive(entry: SweepEntry, record: HostRecord, rules: FleetRules): HostLive {
    const problems: string[] = []
    let status = agentStatus(entry.agent, entry.reach)
    const agent = entry.agent

    if (entry.reach !== 'ok') {
      problems.push(entry.reachMessage)
    }
    if (agent) {
      if (agent.state !== 'ready') problems.push(agent.message)
      for (const instance of agent.instances) {
        const instanceStatusValue = instanceStatus(instance.state, rules.degradedIsAmber)
        status = worst(status, instanceStatusValue)
        if (instanceStatusValue === 'bad') {
          problems.push(`${instance.displayName} is ${instance.state}`)
        } else if (instanceStatusValue === 'warn' && instance.state === 'degraded') {
          const missing = instance.units.filter((unit) => unit.state !== 'running').map((u) => u.name)
          problems.push(
            `${instance.displayName} is degraded${missing.length ? ` - ${missing.join(', ')} not running` : ''}`
          )
        }
      }
      if (agent.net?.online === false) {
        status = worst(status, 'bad')
        problems.push('this machine reports no internet connection')
      }
    }

    const summary = summaryFor(entry, agent)
    return {
      ip: entry.ip,
      cred: entry.cred,
      reach: entry.reach,
      reachMessage: entry.reachMessage,
      agent,
      status,
      summary,
      note: problems.length ? problems.join(' · ') : noteFor(entry, agent, record),
      problems
    }
  }

  /** Drop a machine the user does not want to see any more. */
  forget(ip: string): boolean {
    const data = this.store.read()
    if (!data.hosts[ip]) return false
    this.store.update((d) => {
      delete d.hosts[ip]
    })
    this.live.delete(ip)
    this.generation++
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
    this.generation++
    return orphans.length
  }

  // ------------------------------------------------------------------ tokens

  tokenFor(ip: string): string {
    return this.store.read().hosts[ip]?.agentToken ?? ''
  }

  /** Remember the token an install printed. Written straight through to disk. */
  setToken(ip: string, token: string): void {
    this.store.update((data) => {
      const record = data.hosts[ip]
      if (record) record.agentToken = token || undefined
    })
    this.store.persist()
    this.generation++
  }

  cursorFor(ip: string): number | null {
    return this.store.read().hosts[ip]?.telemetryCursor ?? null
  }

  /**
   * Advance a machine's telemetry cursor, only ever forwards.
   *
   * Only forwards because a pull that answered with older rows than the cursor
   * - a clock that stepped back, an agent restored from a backup - would
   * otherwise make the module re-append everything after it on every tick.
   */
  setCursor(ip: string, cursor: number): void {
    this.store.update((data) => {
      const record = data.hosts[ip]
      if (record && (record.telemetryCursor == null || cursor > record.telemetryCursor)) {
        record.telemetryCursor = cursor
      }
    })
    this.generation++
  }

  // ------------------------------------------------------------------- views

  /** The `fleet` stream: only what a card draws, capped, so the payload stays small. */
  cards(rules: FleetRules): HostsPayload {
    const hosts: HostCard[] = []
    const counts: FleetCounts = {
      total: 0,
      ready: 0,
      noAgent: 0,
      unreachable: 0,
      unknown: 0,
      instancesRunning: 0,
      instancesDegraded: 0,
      instancesFailed: 0,
      hostsOffline: 0
    }
    for (const live of this.live.values()) {
      counts.total++
      const state = live.agent?.state
      if (state === 'ready' || state === 'outdated') counts.ready++
      else if (state === 'none' || state === 'untrusted') counts.noAgent++
      else if (state === 'unreachable') counts.unreachable++
      else counts.unknown++
      if (live.agent?.net?.online === false) counts.hostsOffline++

      const services: StatusChip[] = []
      if (live.agent && live.agent.state !== 'ready' && live.agent.state !== 'outdated') {
        services.push(chip(live.agent.state, 'bad'))
      } else if (live.agent?.state === 'outdated') {
        services.push(chip(`agent ${live.agent.version ?? '?'}`, 'warn'))
      }
      for (const instance of live.agent?.instances ?? []) {
        if (instance.state === 'running') counts.instancesRunning++
        else if (instance.state === 'degraded') counts.instancesDegraded++
        else if (instance.state === 'failed') counts.instancesFailed++
        if (services.length >= rules.cardInstances) continue
        services.push(
          chip(`${instance.id} ${instance.state}`, instanceStatus(instance.state, rules.degradedIsAmber))
        )
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

  /** Cleared whenever the roster changes; see `generation`. */
  private rowCache(): typeof this.rows {
    if (this.rows.generation !== this.generation) this.rows = { generation: this.generation }
    return this.rows
  }

  /** The Machines page: one row per address in the roster. */
  hostRows(): Array<Record<string, unknown>> {
    const cache = this.rowCache()
    return (cache.hosts ??= this.buildHostRows())
  }

  private buildHostRows(): Array<Record<string, unknown>> {
    const data = this.store.read()
    const out: Array<Record<string, unknown>> = []
    for (const [ip, record] of Object.entries(data.hosts)) {
      const live = this.live.get(ip)
      const agentState = live?.agent?.state ?? record.agentState ?? 'unknown'
      const instances = live?.agent?.instances ?? []
      out.push({
        ip,
        label: record.label ?? '',
        hostname: record.hostname ?? '',
        reach: record.reach,
        reachBadges: statusBadges(record.reach === 'ok' ? 'ok' : record.reach),
        note: record.reachNote,
        agent: agentState,
        agentBadges: statusBadges(agentState),
        agentVersion: live?.agent?.version ?? record.agentVersion ?? '',
        instanceCount: instances.length,
        instanceBadges: countBadges([
          { label: 'running', count: instances.filter((i) => i.state === 'running').length, color: BADGE.good },
          { label: 'degraded', count: instances.filter((i) => i.state === 'degraded').length, color: BADGE.warn },
          { label: 'failed', count: instances.filter((i) => i.state === 'failed').length, color: BADGE.bad }
        ]),
        publicIp: live?.agent?.net?.publicIp ?? '',
        latencyMs: live?.agent?.net?.latencyMs ?? null,
        // Raw epoch ms: the spec's `time` format renders it in the viewer's own
        // locale, and a module that pre-formatted it would bake the server's in.
        lastSeen: record.lastSeen,
        lastProbeAt: record.lastProbeAt,
        firstSeen: record.firstSeen || null,
        pinned: record.pinned,
        hasToken: Boolean(record.agentToken),
        username: live?.cred.username ?? '',
        port: live?.cred.port ?? 22
      })
    }
    out.sort((a, b) => compareIp(String(a.ip), String(b.ip)))
    return out
  }

  /** The Services page: one row per machine and instance, so a bulk action can tick across machines. */
  instanceRows(rules: FleetRules): Array<Record<string, unknown>> {
    const cache = this.rowCache()
    return (cache.instances ??= this.buildInstanceRows(rules))
  }

  private buildInstanceRows(rules: FleetRules): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const live of this.live.values()) {
      for (const instance of live.agent?.instances ?? []) {
        const status = instanceStatus(instance.state, rules.degradedIsAmber)
        out.push({
          // `<ip>|<id>` is the row's identity, and what a bulk action gets a
          // list of. A table needs one unique key per row and neither half is
          // unique on its own.
          key: `${live.ip}|${instance.id}`,
          ip: live.ip,
          label: live.cred.label ?? '',
          template: instance.id,
          displayName: instance.displayName,
          kind: instance.kind,
          state: instance.state,
          stateBadges: statusBadges(instance.state),
          tone: status,
          units: instance.units.map((unit) => `${unit.name}=${unit.state}`).join(', '),
          unitBadges: countBadges([
            { label: 'running', count: instance.units.filter((u) => u.state === 'running').length, color: BADGE.good },
            {
              label: 'stopped',
              count: instance.units.filter((u) => u.state !== 'running').length,
              color: BADGE.warn
            }
          ]),
          restarts: instance.units.reduce((sum, unit) => sum + (unit.restartCount ?? 0), 0),
          hasCredentials: instance.hasCredentials,
          updatedAt: instance.updatedAt ?? null
        })
      }
    }
    out.sort(
      (a, b) =>
        compareIp(String(a.ip), String(b.ip)) || String(a.template).localeCompare(String(b.template))
    )
    return out
  }

  /**
   * The Fleet page's network view: one row per agent, carrying the public
   * address it sees itself as.
   *
   * `sharesIp` is computed here rather than in the spec because a block cannot
   * count its own rows. It is what surfaces the collision these platforms
   * actually care about - Honeygain's terms forbid several devices behind one
   * connection, so two agents reporting one address running one template is a
   * thing the user needs told, not a thing they should have to notice.
   */
  netRows(): Array<Record<string, unknown>> {
    const cache = this.rowCache()
    return (cache.net ??= this.buildNetRows())
  }

  private buildNetRows(): Array<Record<string, unknown>> {
    const live = [...this.live.values()].filter((entry) => entry.agent?.net)
    const byIp = new Map<string, HostLive[]>()
    for (const entry of live) {
      const publicIp = entry.agent?.net?.publicIp ?? ''
      if (!publicIp) continue
      const bucket = byIp.get(publicIp)
      if (bucket) bucket.push(entry)
      else byIp.set(publicIp, [entry])
    }

    const out: Array<Record<string, unknown>> = []
    for (const entry of live) {
      const net = entry.agent?.net
      const publicIp = net?.publicIp ?? ''
      const sharing = publicIp ? (byIp.get(publicIp)?.length ?? 1) : 1
      const templates = new Set((entry.agent?.instances ?? []).map((instance) => instance.id))
      const clashes = publicIp
        ? (byIp.get(publicIp) ?? [])
            .filter((other) => other.ip !== entry.ip)
            .flatMap((other) => (other.agent?.instances ?? []).map((instance) => instance.id))
            .filter((id) => templates.has(id))
        : []
      const unique = [...new Set(clashes)]
      out.push({
        ip: entry.ip,
        label: entry.cred.label ?? '',
        publicIp: publicIp || '(not measured yet)',
        online: net?.online,
        onlineBadges: statusBadges(net?.online === true ? 'online' : net?.online === false ? 'offline' : ''),
        latencyMs: net?.latencyMs ?? null,
        source: net?.lastIpSource ?? '',
        sharesIp: sharing,
        clashes: unique.join(', '),
        clashBadges: unique.length
          ? [{ label: `${unique.length} shared`, color: BADGE.warn }]
          : [],
        tone: unique.length ? 'warn' : 'ok'
      })
    }
    out.sort(
      (a, b) =>
        String(a.publicIp).localeCompare(String(b.publicIp)) ||
        compareIp(String(a.ip), String(b.ip))
    )
    return out
  }

  /** One machine, for a card's drawer. */
  inspect(ip: string): Record<string, unknown> | null {
    const record = this.store.read().hosts[ip]
    const live = this.live.get(ip)
    if (!record && !live) return null
    const agent = live?.agent
    return {
      ip,
      label: record?.label ?? '',
      hostname: record?.hostname ?? '',
      reach: record?.reach ?? 'unknown',
      reachBadges: statusBadges(record?.reach === 'ok' ? 'ok' : (record?.reach ?? '')),
      note: record?.reachNote ?? '',
      agent: agent?.state ?? record?.agentState ?? 'unknown',
      agentBadges: statusBadges(agent?.state ?? record?.agentState ?? ''),
      agentVersion: agent?.version ?? record?.agentVersion ?? '',
      agentMessage: agent?.message ?? '',
      hasToken: Boolean(record?.agentToken),
      online: agent?.net?.online,
      publicIp: agent?.net?.publicIp ?? '',
      latencyMs: agent?.net?.latencyMs ?? null,
      pingTarget: agent?.net?.lastPingTarget ?? '',
      ipSource: agent?.net?.lastIpSource ?? '',
      instanceCount: agent?.instances.length ?? 0,
      firstSeen: record?.firstSeen || null,
      lastSeen: record?.lastSeen ?? null,
      lastProbeAt: record?.lastProbeAt ?? null,
      username: live?.cred.username ?? '',
      port: live?.cred.port ?? 22,
      problems: live?.problems ?? []
    }
  }

  /** Instances of one machine, for the drawer's table. */
  instancesOf(ip: string): Array<Record<string, unknown>> {
    const live = this.live.get(ip)
    if (!live?.agent) return []
    return live.agent.instances.map((instance) => ({
      key: `${ip}|${instance.id}`,
      template: instance.id,
      displayName: instance.displayName,
      state: instance.state,
      stateBadges: statusBadges(instance.state),
      units: instance.units.map((unit) => `${unit.name}=${unit.state}`).join(', '),
      hasCredentials: instance.hasCredentials,
      ip
    }))
  }

  /** Machines a fan-out may act on, given the rules the user typed. */
  controllable(targets: readonly TargetRule[]): HostLive[] {
    return [...this.live.values()].filter((live) => resolveCredential(live.ip, targets) != null)
  }
}

function summaryFor(entry: SweepEntry, agent: AgentInfo | null): string {
  if (!agent) return entry.reach === 'ok' ? 'not checked yet' : entry.reachMessage
  if (agent.state === 'none') return 'no agent'
  if (agent.state === 'untrusted') return 'agent, no token'
  if (agent.state === 'unreachable') return 'unreachable'
  const running = agent.instances.filter((instance) => instance.state === 'running').length
  const total = agent.instances.length
  if (!total) return 'agent ready, nothing deployed'
  return `${running}/${total} running`
}

function noteFor(entry: SweepEntry, agent: AgentInfo | null, record: HostRecord): string {
  if (agent?.state === 'ready' && agent.instances.length) {
    const ip = agent.net?.publicIp
    return ip ? `Public address ${ip}.` : 'Everything this machine runs is healthy.'
  }
  if (agent?.state === 'ready') {
    return 'The agent is running and has nothing deployed. Use Services → Deploy to give it something.'
  }
  if (record.lastSeen) return `Last reached ${new Date(record.lastSeen).toISOString()}.`
  return entry.reachMessage
}

/** Re-exported so pages and tests share one vocabulary. */
export { statusTone }
