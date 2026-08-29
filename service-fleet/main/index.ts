/**
 * Services - a fleet of BoredAgents, watched and controlled from one page.
 *
 * The module reaches machines the app is not connected to by using the machine
 * it *is* connected to as a jump host, in two ways that do different jobs:
 *
 * - **SSH** (`fanout.ts`) finds machines and installs the agent. It is the only
 *   thing that can tell "nothing is at .137" from "a machine is there and
 *   refuses the login", and it is expensive.
 * - **HTTP** (`agentfan.ts`) does everything after that, by running `curl` on
 *   the jump host against each agent's own API. Twenty containers stopped is
 *   twenty requests from one machine, not twenty SSH sessions.
 *
 * Three rules shape everything in here:
 *
 * - **Only the sweep, the collector and jobs touch the network.** Every
 *   `invoke` method answers from memory, so the pages can re-poll at the fast
 *   interval without opening a connection. The exceptions say so in their own
 *   comments (`hostProbe`, `instanceLogs`, `targetTest`, and the actions).
 * - **The slow interval is the sweep.** A fan-out over a subnet takes seconds
 *   and shares one connection with the app's own collectors, so it runs on
 *   `slowRefresh` where "Manual only" is a real choice.
 * - **Telemetry is pulled on its own, slower timer.** Agents keep their own
 *   daily rows for over a year, so this is catching up rather than sampling -
 *   and doing it on every sweep would be asking fifty machines for a day's
 *   worth of rows they have not finished writing.
 */
import type { ModuleActivate, ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { InstanceActions, type InstanceAction } from './actions'
import { AGENT_VERSION } from './agent/manifest'
import { statusBadges } from './badges'
import { ConfigStore, resolveCredential } from './config'
import { RulesEditor, TargetEditor } from './editors'
import { classifyReach, reachMessage, runFanout } from './fanout'
import { HOST_PROBE_SCRIPT } from './hostprobe'
import { FleetJobs } from './jobs'
import { agentOptions, selectOptions } from './options'
import { emptyCapabilities, probeJumpHost, type JumpCapabilities } from './probe'
import { Roster } from './roster'
import { effectiveRules } from './rules'
import { HostStore } from './store'
import { Sweeper } from './sweep'
import { AgentInstaller } from './agent/installer'
import { buildLibrary, exportDocument, findTemplate } from './templates/library'
import { Deployer } from './templates/deploy'
import { TelemetryCollector } from './telemetry/collect'
import { Reports } from './telemetry/report'
import { TemplateEditor } from './templates/editor'

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
  const library = () => buildLibrary(config.read().templates)

  const sweeper = new Sweeper(ctx, roster, deps)
  const actions = new InstanceActions(ctx, roster)
  const collector = new TelemetryCollector(ctx, roster)
  const reports = new Reports({
    ctx,
    labelFor: (ip) => roster.records()[ip]?.label ?? ''
  })
  const installer = new AgentInstaller(ctx, roster, jobs, sweeper, deps)
  const deployer = new Deployer(roster, jobs, actions, sweeper, deps, library)
  const templates = new TemplateEditor(ctx, config, deps)
  const targets = new TargetEditor(ctx, config, roster, deps)
  const rulesEditor = new RulesEditor(ctx, config)

  /** Whether the explanatory notes are shown. One flag, read by every page. */
  const uiState = (): { hintsOn: boolean; agentVersion: string } => ({
    hintsOn: config.read().hintsOn,
    agentVersion: AGENT_VERSION
  })

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
    else if (capabilities.warning) ctx.log(`service-fleet: ${capabilities.warning}`)
    return capabilities
  }

  // ---------------------------------------------------------------- reading

  ctx.handle('capabilities', () => capabilities)
  ctx.handle('ui', () => uiState())
  ctx.handle('agentRows', () => roster.hostRows())
  ctx.handle('instanceRows', () => roster.instanceRows(deps.rules()))
  ctx.handle('netRows', () => roster.netRows())
  ctx.handle('hostInspect', (ip: unknown) => roster.inspect(String(ip ?? '')))
  ctx.handle('hostInstances', (ip: unknown) => roster.instancesOf(String(ip ?? '')))
  ctx.handle('targets', () => targets.rows())
  ctx.handle('templateRows', () => templates.rows(library()))
  ctx.handle('templateExport', (id: unknown) => {
    const entry = findTemplate(library(), String(id ?? ''))
    if (!entry) return { id: String(id ?? ''), lines: [] }
    // Answered as lines rather than one string: a `list` block can render them
    // read-only, where a `form` would need a submit button that did nothing.
    return {
      id: entry.id,
      lines: exportDocument(entry)
        .split('\n')
        .map((line) => ({ line }))
    }
  })
  ctx.handle('templateDetail', (id: unknown) => {
    const entry = findTemplate(library(), String(id ?? ''))
    if (!entry) return null
    return {
      id: entry.id,
      name: entry.template.displayName,
      kind: entry.template.kind,
      version: entry.template.version,
      description: entry.template.description,
      units: entry.template.units.join(', '),
      privileged: entry.template.privileged ? 'yes - it can run a shell as root' : 'no',
      origin: entry.origin === 'seed' ? 'ships with the module' : 'yours'
    }
  })
  ctx.handle('templateFields', (id: unknown) => templates.fields(library(), String(id ?? '')))
  ctx.handle('rulesEffective', () => rulesEditor.effective())
  ctx.handle('collectSummary', () => collector.summary())
  ctx.handle('selectOptions', (kind: unknown) => selectOptions(kind, config.read(), roster, library()))
  ctx.handle('agentOptions', () => agentOptions(roster))

  // ---------------------------------------------------------------- reports

  // These read the record store rather than memory, which is why they are the
  // only `invoke` methods that await anything on a page that is merely open.
  // The store is local: no network, no agent, no jump host.
  ctx.handle('reportBandwidth', (days: unknown, ip: unknown) =>
    reports.bandwidthRows(days, ip ? String(ip) : undefined)
  )
  ctx.handle('reportBandwidthSeries', (days: unknown, ip: unknown) =>
    reports.bandwidthSeries(days, ip ? String(ip) : undefined)
  )
  ctx.handle('reportUptime', (days: unknown, ip: unknown) =>
    reports.uptimeRows(days, ip ? String(ip) : undefined)
  )
  ctx.handle('reportUptimeSummary', (days: unknown) => reports.uptimeSummary(days))
  ctx.handle('reportIncidents', (days: unknown, kind: unknown, ip: unknown) =>
    reports.incidentRows(days, kind, ip ? String(ip) : undefined)
  )
  ctx.handle('storageUsage', () => reports.usage())

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

  ctx.handle('collectNow', async (): Promise<OkResult> => {
    if (!ctx.connected) return { ok: false, error: 'not connected to a machine' }
    const summary = await collector.collect(deps.rules())
    return { ok: true, data: summary.message }
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
    const results = await runFanout(ctx, [{ ip, cred }], HOST_PROBE_SCRIPT, rules)
    const result = results[0]
    if (!result) return { ok: false, error: 'the connected machine returned nothing' }
    const reach = classifyReach(result)
    // The sweeper owns agent detection, so a manual probe and a sweep cannot
    // drift on what it means - and going through it republishes the wall. It
    // costs one more SSH round trip than reusing the answer above; that is the
    // price of there being exactly one place that decides what an agent's
    // state is.
    await sweeper.refreshOne(ip)
    return reach === 'ok'
      ? { ok: true, data: reachMessage(reach, result) }
      : { ok: false, error: reachMessage(reach, result) }
  })

  // Takes one address from a row action or an array from the table's selection,
  // so the same method serves both without a second name for it.
  ctx.handle('hostForget', (ipRaw: unknown): OkResult => {
    const list = Array.isArray(ipRaw) ? ipRaw.map((ip) => String(ip ?? '')) : [String(ipRaw ?? '')]
    const dropped = list.filter((ip) => roster.forget(ip))
    if (dropped.length === 0) return { ok: false, error: 'none of those addresses are in the roster' }
    return { ok: true, data: `${dropped.length} dropped` }
  })

  // ---------------------------------------------------------------- agents

  ctx.handle('agentInstallCheck', (values: unknown) => installer.check(values))
  ctx.handle('agentInstallApply', (payload: unknown) => installer.apply(payload))
  ctx.handle('agentUninstallCheck', (values: unknown) => installer.uninstallCheck(values))
  ctx.handle('agentUninstallApply', (payload: unknown) => installer.uninstallApply(payload))

  // ---------------------------------------------------------------- instances

  ctx.handle('instanceAction', async (key: unknown, action: unknown): Promise<OkResult> => {
    const [outcome] = await actions.run([String(key ?? '')], String(action ?? '') as InstanceAction, deps.rules())
    if (!outcome) return { ok: false, error: 'nothing to act on' }
    await sweeper.refreshOne(outcome.ip)
    return outcome.ok ? { ok: true, data: outcome.message } : { ok: false, error: outcome.message }
  })

  ctx.handle('bulkInstanceAction', (keys: unknown, action: unknown) =>
    deployer.bulkAction(keys, action)
  )

  ctx.handle('deployCheck', (values: unknown) => deployer.check(values))
  ctx.handle('deployApply', (payload: unknown) => deployer.apply(payload))

  /** One instance's log tail. Goes to the agent, and says so on the page. */
  ctx.handle('instanceLogs', async (key: unknown, unit: unknown) => {
    const [ip, template] = String(key ?? '').split('|')
    if (!ip || !template) return { ok: false, error: 'that row has no instance behind it' }
    return actions.logs(ip, template, deps.rules(), { unit: unit ? String(unit) : undefined })
  })

  // Jobs are decorated here rather than in a spec, because a table cannot
  // divide two columns, colour a word, or turn milliseconds into "4.2s".
  ctx.handle('jobRows', () =>
    jobs.snapshot().jobs.map((job) => ({
      id: job.id,
      label: job.label,
      kind: job.kind,
      state: job.state,
      stateBadges: statusBadges(job.state === 'done' ? 'ok' : job.state),
      running: job.state === 'running',
      done: job.done,
      failed: job.failed,
      total: job.total,
      progressPct: job.progressPct,
      progressLabel: `${job.done}/${job.total} done${job.failed ? `, ${job.failed} failed` : ''}`,
      health: job.failed ? 'bad' : job.state === 'running' ? 'unknown' : 'ok',
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      tookLabel: job.finishedAt ? `${Math.round((job.finishedAt - job.startedAt) / 100) / 10}s` : '',
      chips: job.items.slice(0, 40).map((jobItem) => ({
        label: `${jobItem.name}${jobItem.message ? `: ${jobItem.message}` : ''}`.slice(0, 80),
        status: jobItem.status === 'ok' ? 'ok' : jobItem.status === 'error' ? 'bad' : 'unknown',
        pinned: jobItem.status === 'error'
      }))
    }))
  )
  ctx.handle('jobItems', (id: unknown) => {
    const job = jobs.snapshot().jobs.find((entry) => entry.id === String(id ?? ''))
    return (job?.items ?? []).map((jobItem) => ({
      name: jobItem.name,
      status: jobItem.status,
      message: jobItem.message ?? '',
      ms: jobItem.ms ?? null
    }))
  })

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

  ctx.handle('templateImportCheck', (values: unknown) => templates.check(values))
  ctx.handle('templateImportApply', (payload: unknown) => templates.apply(payload))
  ctx.handle('templateDelete', (id: unknown) => templates.delete(id))

  ctx.handle('rulesCheck', (values: unknown) => rulesEditor.check(values))
  ctx.handle('rulesApply', (payload: unknown) => rulesEditor.apply(payload))
  ctx.handle('rulesReset', () => rulesEditor.reset())

  ctx.handle('hintsSet', (values: unknown): OkResult => {
    const on = (values as { hintsOn?: unknown } | null)?.hintsOn !== false
    config.update((document) => {
      document.hintsOn = on
    })
    ctx.emit('ui', uiState())
    return { ok: true, data: on ? 'Notes shown.' : 'Notes hidden.' }
  })

  // ---------------------------------------------------------------- lifecycle

  /** What the last applyPollers decided, so a settings tick cannot restart a sweep in flight. */
  let applied: string | null = null
  let collectTimer: ReturnType<typeof setInterval> | null = null

  const stopCollector = (): void => {
    if (collectTimer) clearInterval(collectTimer)
    collectTimer = null
  }

  return {
    applyPollers() {
      const seconds = Math.max(0, ctx.slowIntervalSec(INTERVAL_KEY))
      const primary = ctx.isPrimaryInstance
      const key = `${ctx.connected}|${seconds}|${primary}`
      if (key === applied) return
      applied = key
      sweeper.poller.stop()
      stopCollector()
      // The sweep reaches a subnet the user configured, not this instance's
      // own connected machine - two connected machines both enabled for this
      // module would otherwise fan out the same sweep twice. Only the elected
      // primary runs it automatically; a manual "sweep now" is unaffected.
      if (!ctx.connected || !primary) return
      // Asking the jump host what it can do is the first thing that happens on a
      // connection, because everything else depends on the answer. The module can
      // be switched off while that is in flight, so the continuation checks.
      void refreshCapabilities().then(
        () => {
          if (stopped || !ctx.connected || applied !== key) return
          if (seconds > 0) sweeper.poller.start(seconds * 1000)
          // Manual only: still sweep once, so the page is not empty until the
          // user finds the refresh button.
          else if (!sweeper.latest) void sweeper.run().catch(() => undefined)

          // Telemetry runs on its own timer rather than the sweep's, because it
          // is catching up on rows the agents already have rather than
          // sampling: a two-minute cadence would ask fifty machines for a day
          // they have not finished writing.
          const everyMs = Math.max(5, deps.rules().telemetryEveryMin) * 60_000
          collectTimer = setInterval(() => {
            if (stopped || !ctx.connected) return
            void collector.collect(deps.rules()).catch(() => undefined)
          }, everyMs)
          collectTimer.unref?.()
        },
        () => undefined
      )
    },

    reset() {
      // A different jump host is a different network: the roster, what the jump
      // host can do, and every outstanding check token all belonged to the
      // previous one.
      applied = null
      capabilities = emptyCapabilities()
      stopCollector()
      jobs.reset()
      sweeper.reset()
      roster.reset()
      config.reset()
      collector.reset()
      installer.clear()
      deployer.clear()
      templates.clear()
      targets.clear()
    },

    snapshots() {
      return {
        fleet: sweeper.latest,
        series: sweeper.series,
        jobs: jobs.snapshot(),
        sweep: sweeper.status,
        capabilities,
        ui: uiState()
      }
    },

    slowTargets() {
      return [INTERVAL_KEY]
    },

    async refreshSlow() {
      if (!ctx.connected) return
      await refreshCapabilities()
      await sweeper.run()
      await collector.collect(deps.rules()).catch(() => undefined)
    },

    dispose() {
      stopped = true
      // lastSeen alone is not worth a disk write per sweep (see mergeInto), so
      // the last one a sweep recorded is written out here instead.
      roster.flush()
      stopCollector()
      sweeper.poller.stop()
      sweeper.stop()
      jobs.dispose()
    }
  }
}

export default activate
