/**
 * Services - watching and controlling systemd units across a whole IP range.
 *
 * The module reaches machines the app is not connected to by using the machine
 * it *is* connected to as a jump host: one command carries a batch of addresses,
 * fans out with `xargs -P` and `ssh`, and brings the answers back framed per
 * machine. `fanout.ts` has the details and the three properties that must not
 * regress.
 *
 * Two rules shape everything in here:
 *
 * - **Only the sweep and jobs touch the network.** Every `invoke` method answers
 *   from memory, so the pages can re-poll at the fast interval without opening a
 *   single SSH session. The exceptions say so in their own comments
 *   (`hostProbe`, `unitInspect`, `targetTest`, and the actions).
 * - **The slow interval is the sweep.** A fan-out over a subnet takes seconds and
 *   shares one connection with the app's own collectors, so it runs on
 *   `slowRefresh` where "Manual only" is a real choice.
 */
import type { ModuleActivate, ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { Actions, parsePairKey } from './actions'
import { BulkActions } from './bulk'
import { ConfigStore, resolveCredential } from './config'
import { RulesEditor, TargetEditor, WatchedEditor } from './editors'
import { classifyReach, reachMessage, runFanout } from './fanout'
import { Installer } from './install'
import { FleetJobs } from './jobs'
import { selectOptions } from './options'
import { emptyCapabilities, probeJumpHost, type JumpCapabilities } from './probe'
import { healthLabel, Roster, unitStatus } from './roster'
import { effectiveRules } from './rules'
import { HostStore } from './store'
import { Sweeper } from './sweep'
import { parseSweep, sweepCompleted, sweepPayload } from './units'

/** The one interval key this module declares, used for both fast and slow. */
const INTERVAL_KEY = 'service-fleet'

const activate: ModuleActivate = (ctx: ModuleContext) => {
  const config = new ConfigStore(ctx)
  const hostStore = new HostStore(ctx)
  const roster = new Roster(hostStore)
  const jobs = new FleetJobs(ctx, hostStore)

  let capabilities: JumpCapabilities = emptyCapabilities()
  /** Set by `dispose`, so nothing a probe was waiting on starts work afterwards. */
  let stopped = false
  const deps = {
    config: () => config.read(),
    rules: () => effectiveRules(ctx),
    capabilities: () => capabilities
  }

  const sweeper = new Sweeper(ctx, roster, deps)
  const actions = new Actions(ctx, roster, jobs, sweeper, deps)
  const bulk = new BulkActions(roster, actions, deps)
  const installer = new Installer(roster, actions, deps)
  const targets = new TargetEditor(ctx, config, roster, deps)
  const watched = new WatchedEditor(ctx, config, roster)
  const rulesEditor = new RulesEditor(ctx, config)

  /**
   * Ask the jump host what it has, then sweep. Run on activate, on connect and
   * whenever the user presses Refresh: the answer belongs to the machine the app
   * is connected to, so it is worthless after a reconnect.
   */
  const refreshCapabilities = async (): Promise<JumpCapabilities> => {
    const next = await probeJumpHost(ctx)
    if (stopped) return next
    capabilities = next
    ctx.emit('capabilities', capabilities)
    if (capabilities.problem) ctx.log(`service-fleet: ${capabilities.problem}`)
    return capabilities
  }

  // ---------------------------------------------------------------- reading

  ctx.handle('capabilities', () => capabilities)
  ctx.handle('hostRows', () => roster.hostRows())
  ctx.handle('unitRows', () => roster.unitRows())
  ctx.handle('hostInspect', (ip: unknown) => roster.inspect(String(ip ?? '')))
  ctx.handle('jobs', () => jobs.list())
  ctx.handle('targets', () => targets.rows())
  ctx.handle('watched', () => watched.rows())
  ctx.handle('rulesEffective', () => rulesEditor.effective())
  ctx.handle('selectOptions', (kind: unknown) => selectOptions(kind, config.read(), roster))

  /** Every unit known for one machine, out of the last sweep - no network. */
  ctx.handle('hostUnits', (ipRaw: unknown) => {
    const ip = String(ipRaw ?? '')
    return roster.unitsFor(ip).map(({ state, watched: isWatched, severity }) => ({
      id: `${ip}|${state.unit}`,
      ip,
      unit: state.unit,
      watched: isWatched ? 'yes' : '',
      severity: isWatched ? severity : '',
      status: unitStatus(state, isWatched, severity === 'critical'),
      health: healthLabel(state),
      fileState: state.fileState,
      description: state.description
    }))
  })

  // ---------------------------------------------------------------- sweeping

  ctx.handle('sweepNow', async (): Promise<OkResult> => {
    if (!ctx.connected) return { ok: false, error: 'not connected to a machine' }
    await refreshCapabilities()
    if (capabilities.problem) return { ok: false, error: capabilities.problem }
    await sweeper.run()
    return { ok: true, data: sweeper.status.message }
  })

  ctx.handle('sweepCancel', (): OkResult => {
    sweeper.cancel()
    return { ok: true }
  })

  /**
   * Re-read one machine on demand. This one does go to the network - it is the
   * button a user presses because they do not believe the card.
   */
  ctx.handle('hostProbe', async (ipRaw: unknown): Promise<OkResult> => {
    const ip = String(ipRaw ?? '')
    if (!ctx.connected) return { ok: false, error: 'not connected to a machine' }
    const cred = resolveCredential(ip, config.read().targets)
    if (!cred) return { ok: false, error: `${ip} is not covered by any address rule` }
    const rules = deps.rules()
    const results = await runFanout(ctx, [{ ip, cred }], sweepPayload(config.read().watched, rules), rules)
    const result = results[0]
    if (!result) return { ok: false, error: 'the connected machine returned nothing' }
    const reach = classifyReach(result)
    const facts =
      reach === 'ok' && sweepCompleted(result.stdout) ? parseSweep(result.stdout, rules.maxUnitsPerHost) : null
    roster.applyOne(
      { ip, cred, reach, reachMessage: reachMessage(reach, result), facts },
      config.read().watched,
      rules
    )
    await sweeper.refreshOne(ip).catch(() => undefined)
    return reach === 'ok' ? { ok: true, data: reachMessage(reach, result) } : { ok: false, error: reachMessage(reach, result) }
  })

  // Takes one address from a row action or an array from the table's selection,
  // so the same method serves both without a second name for it.
  ctx.handle('hostForget', (ipRaw: unknown): OkResult => {
    const list = Array.isArray(ipRaw) ? ipRaw.map((ip) => String(ip ?? '')) : [String(ipRaw ?? '')]
    const dropped = list.filter((ip) => roster.forget(ip))
    if (dropped.length === 0) return { ok: false, error: 'none of those addresses are in the roster' }
    return { ok: true, data: `${dropped.length} dropped` }
  })

  // ---------------------------------------------------------------- controlling

  ctx.handle('unitAction', (ip: unknown, unit: unknown, action: unknown) => actions.unitAction(ip, unit, action))
  ctx.handle('bulkUnitAction', (keys: unknown, action: unknown) => actions.bulkUnitAction(keys, action))
  ctx.handle('hostAction', (ip: unknown, action: unknown) => actions.hostAction(ip, action))
  ctx.handle('unitInspect', (id: unknown) => {
    // The Services page keys its rows `<ip>|<unit>`, so one argument is enough.
    const pair = parsePairKey(id)
    return pair ? actions.unitInspect(pair.ip, pair.unit) : null
  })
  ctx.handle('logsStart', (id: unknown) => actions.logsStart(id))
  ctx.handle('logsStop', (id: unknown) => actions.logsStop(id))

  ctx.handle('bulkActionCheck', (values: unknown) => bulk.check(values))
  ctx.handle('bulkActionApply', (payload: unknown) => bulk.apply(payload))
  ctx.handle('installCheck', (values: unknown) => installer.check(values))
  ctx.handle('installApply', (payload: unknown) => installer.apply(payload))

  ctx.handle('jobCancel', (id: unknown) => jobs.cancel(id))
  ctx.handle('jobsClear', () => jobs.clearFinished())

  // ---------------------------------------------------------------- settings

  // Both pairs take an optional leading id: the same form serves "add" on the
  // page and "edit" in a row's drawer, and which one it is shows in the argument
  // count (`argsFromScope: ["id"]` on the drawer's copy).
  ctx.handle('targetCheck', (...args: unknown[]) =>
    args.length >= 2 ? targets.check(String(args[0]), args[1]) : targets.check(null, args[0])
  )
  ctx.handle('targetApply', (...args: unknown[]) =>
    args.length >= 2 ? targets.apply(String(args[0]), args[1]) : targets.apply(null, args[0])
  )
  ctx.handle('targetDelete', (id: unknown) => targets.delete(id))
  ctx.handle('targetTest', (id: unknown) => targets.test(id))

  ctx.handle('watchedCheck', (...args: unknown[]) =>
    args.length >= 2 ? watched.check(String(args[0]), args[1]) : watched.check(null, args[0])
  )
  ctx.handle('watchedApply', (...args: unknown[]) =>
    args.length >= 2 ? watched.apply(String(args[0]), args[1]) : watched.apply(null, args[0])
  )
  ctx.handle('watchedDelete', (id: unknown) => watched.delete(id))

  ctx.handle('rulesCheck', (values: unknown) => rulesEditor.check(values))
  ctx.handle('rulesApply', (payload: unknown) => rulesEditor.apply(payload))
  ctx.handle('rulesReset', () => rulesEditor.reset())

  // ---------------------------------------------------------------- lifecycle

  /** What the last applyPollers decided, so a settings tick cannot restart a sweep in flight. */
  let applied: string | null = null

  return {
    applyPollers() {
      const seconds = Math.max(0, ctx.slowIntervalSec(INTERVAL_KEY))
      const key = `${ctx.connected}|${seconds}`
      if (key === applied) return
      applied = key
      sweeper.poller.stop()
      if (!ctx.connected) return
      // Asking the jump host what it can do is the first thing that happens on a
      // connection, because everything else depends on the answer. The module can
      // be switched off while that is in flight, so the continuation checks.
      void refreshCapabilities().then(
        () => {
          if (stopped || !ctx.connected) return
          if (seconds > 0) sweeper.poller.start(seconds * 1000)
          // Manual only: still sweep once, so the page is not empty until the
          // user finds the refresh button.
          else if (!sweeper.latest) void sweeper.run()
        },
        () => undefined
      )
    },

    reset() {
      // A different jump host is a different network: the roster, the unit
      // lists, what the jump host can do, and every outstanding check token all
      // belonged to the previous one.
      applied = null
      capabilities = emptyCapabilities()
      jobs.reset()
      sweeper.reset()
      roster.reset()
      config.reset()
      bulk.clear()
      installer.clear()
      targets.clear()
      watched.clear()
      actions.dispose()
    },

    snapshots() {
      return {
        hosts: sweeper.latest,
        series: sweeper.series,
        jobs: jobs.snapshot(),
        sweep: sweeper.status,
        capabilities
      }
    },

    slowTargets() {
      return [INTERVAL_KEY]
    },

    async refreshSlow() {
      if (!ctx.connected) return
      await refreshCapabilities()
      await sweeper.run()
    },

    dispose() {
      stopped = true
      sweeper.poller.stop()
      sweeper.cancel()
      jobs.dispose()
      actions.dispose()
    }
  }
}

export default activate
