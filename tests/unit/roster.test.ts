import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../helpers/module-harness'
import { HostStore } from '../../service-fleet/main/store'
import { Roster, agentStatus, instanceStatus, type SweepEntry } from '../../service-fleet/main/roster'
import { DEFAULT_RULES } from '../../service-fleet/main/rules'
import type { TargetRule } from '../../service-fleet/main/config'
import type { AgentInfo, AgentInstance } from '../../service-fleet/main/agent/types'

/**
 * The roster decides what a person sees, so most of what is worth testing here
 * is about restraint: which addresses earn a card at all, which failures are
 * worth a colour, and which are the same colour on purpose.
 */

function rule(overrides: Partial<TargetRule> = {}): TargetRule {
  return {
    id: 't1',
    kind: 'cidr',
    value: '10.0.0.0/24',
    enabled: true,
    port: 22,
    username: 'root',
    auth: 'agent',
    sudo: 'none',
    excludes: [],
    createdAt: 0,
    ...overrides
  }
}

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    state: 'ready',
    version: '1.0.0',
    message: 'answered',
    instances: [],
    net: null,
    checkedAt: Date.now(),
    ...overrides
  }
}

function instance(overrides: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: 'honeygain',
    displayName: 'Honeygain',
    kind: 'container',
    state: 'running',
    units: [{ name: 'honeygain', state: 'running' }],
    hasCredentials: true,
    ...overrides
  }
}

function entry(overrides: Partial<SweepEntry> = {}): SweepEntry {
  return {
    ip: '10.0.0.5',
    cred: rule(),
    reach: 'ok',
    reachMessage: 'ok',
    facts: null,
    agent: null,
    ...overrides
  }
}

function newRoster(): Roster {
  const { ctx } = moduleHarness('service-fleet', async () => ({ code: 0, stdout: '', stderr: '' }))
  return new Roster(new HostStore(ctx))
}

describe('which addresses earn a card', () => {
  it('keeps an address that answered', () => {
    const roster = newRoster()
    roster.apply([entry()], DEFAULT_RULES)
    expect(roster.size).toBe(1)
  })

  it('leaves out an address inside a range that nothing answered from', () => {
    // Without this, watching one /24 would draw 249 red cards for addresses
    // nothing has ever lived at, and the five real machines would be lost.
    const roster = newRoster()
    roster.apply([entry({ reach: 'unreachable', reachMessage: 'no route' })], DEFAULT_RULES)
    expect(roster.size).toBe(0)
  })

  it('keeps an address that refused the login - found it, cannot get in', () => {
    const roster = newRoster()
    roster.apply([entry({ reach: 'auth', reachMessage: 'permission denied' })], DEFAULT_RULES)
    expect(roster.size).toBe(1)
  })

  it('keeps a single address the user named, even when it has never answered', () => {
    // "This machine is down" and "nothing lives at .137" are different things,
    // and naming an address explicitly is how a user says which one they mean.
    const roster = newRoster()
    roster.apply(
      [entry({ cred: rule({ kind: 'host', value: '10.0.0.5' }), reach: 'timeout', reachMessage: 'timed out' })],
      DEFAULT_RULES
    )
    expect(roster.size).toBe(1)
  })

  it('keeps a machine that stops answering rather than dropping it', () => {
    const roster = newRoster()
    roster.apply([entry()], DEFAULT_RULES)
    roster.apply([entry({ reach: 'timeout', reachMessage: 'timed out' })], DEFAULT_RULES)
    expect(roster.size).toBe(1)
    expect(roster.cards(DEFAULT_RULES).hosts[0].status).toBe('bad')
  })
})

describe('what colour a machine is', () => {
  it('is green when the agent is ready and everything it runs is running', () => {
    const roster = newRoster()
    roster.apply([entry({ agent: agent({ instances: [instance()] }) })], DEFAULT_RULES)
    expect(roster.cards(DEFAULT_RULES).hosts[0].status).toBe('ok')
  })

  it('is amber, not red, when a machine simply has no agent', () => {
    // The machine is fine; the fleet just does not manage it yet, and that is
    // one click away from being fixed.
    expect(agentStatus(agent({ state: 'none' }), 'ok')).toBe('warn')
    expect(agentStatus(agent({ state: 'untrusted' }), 'ok')).toBe('warn')
    expect(agentStatus(agent({ state: 'outdated' }), 'ok')).toBe('warn')
  })

  it('is red when nothing answered at all', () => {
    expect(agentStatus(agent({ state: 'unreachable' }), 'timeout')).toBe('bad')
  })

  it('is red when the machine itself reports no internet', () => {
    const roster = newRoster()
    roster.apply(
      [
        entry({
          agent: agent({
            instances: [instance()],
            net: { online: false, latencyMs: null, publicIp: null, lastIpSource: null, lastPingTarget: null }
          })
        })
      ],
      DEFAULT_RULES
    )
    const card = roster.cards(DEFAULT_RULES).hosts[0]
    expect(card.status).toBe('bad')
    expect(card.note).toContain('no internet')
  })

  it('treats a degraded instance as amber, and can be told not to', () => {
    expect(instanceStatus('degraded', true)).toBe('warn')
    expect(instanceStatus('degraded', false)).toBe('ok')
    expect(instanceStatus('failed', true)).toBe('bad')
    expect(instanceStatus('running', true)).toBe('ok')
  })
})

describe('counts', () => {
  it('separates machines with no agent from machines that never answered', () => {
    const roster = newRoster()
    roster.apply(
      [
        entry({ ip: '10.0.0.1', agent: agent({ instances: [instance()] }) }),
        entry({ ip: '10.0.0.2', agent: agent({ state: 'none', message: 'no agent' }) }),
        entry({
          ip: '10.0.0.3',
          cred: rule({ kind: 'host', value: '10.0.0.3' }),
          reach: 'timeout',
          reachMessage: 'timed out',
          agent: agent({ state: 'unreachable' })
        })
      ],
      DEFAULT_RULES
    )
    const counts = roster.cards(DEFAULT_RULES).counts
    expect(counts.total).toBe(3)
    expect(counts.ready).toBe(1)
    expect(counts.noAgent).toBe(1)
    expect(counts.unreachable).toBe(1)
    expect(counts.instancesRunning).toBe(1)
  })
})

describe('the public-address view', () => {
  function withPublicIp(ip: string, publicIp: string, templates: string[]): SweepEntry {
    return entry({
      ip,
      agent: agent({
        instances: templates.map((id) => instance({ id, displayName: id })),
        net: { online: true, latencyMs: 12, publicIp, lastIpSource: 'google_ns1', lastPingTarget: '1.1.1.1' }
      })
    })
  }

  it('names the machines that would collide on one connection', () => {
    // The one thing this view exists for: these services forbid several
    // devices behind one address, and nothing else in the app can see it.
    const roster = newRoster()
    roster.apply(
      [
        withPublicIp('10.0.0.1', '203.0.113.10', ['honeygain']),
        withPublicIp('10.0.0.2', '203.0.113.10', ['honeygain']),
        withPublicIp('10.0.0.3', '198.51.100.7', ['honeygain'])
      ],
      DEFAULT_RULES
    )
    const rows = roster.netRows()
    const first = rows.find((row) => row['ip'] === '10.0.0.1')
    expect(first?.['sharesIp']).toBe(2)
    expect(first?.['clashes']).toBe('honeygain')
    expect(first?.['tone']).toBe('warn')

    const alone = rows.find((row) => row['ip'] === '10.0.0.3')
    expect(alone?.['sharesIp']).toBe(1)
    expect(alone?.['clashes']).toBe('')
    expect(alone?.['tone']).toBe('ok')
  })

  it('does not warn when two machines share an address but run different services', () => {
    const roster = newRoster()
    roster.apply(
      [
        withPublicIp('10.0.0.1', '203.0.113.10', ['honeygain']),
        withPublicIp('10.0.0.2', '203.0.113.10', ['pawns'])
      ],
      DEFAULT_RULES
    )
    const rows = roster.netRows()
    expect(rows.every((row) => row['clashes'] === '')).toBe(true)
    expect(rows.every((row) => row['sharesIp'] === 2)).toBe(true)
  })
})

describe('tokens and cursors', () => {
  it('remembers a token against the machine it belongs to', () => {
    const roster = newRoster()
    roster.apply([entry()], DEFAULT_RULES)
    roster.setToken('10.0.0.5', 'abc123')
    expect(roster.tokenFor('10.0.0.5')).toBe('abc123')
    expect(roster.tokenFor('10.0.0.6')).toBe('')
  })

  it('moves a telemetry cursor forwards only', () => {
    // A clock that stepped back, or an agent restored from a backup, would
    // otherwise make the module re-append everything after it on every tick.
    const roster = newRoster()
    roster.apply([entry()], DEFAULT_RULES)
    roster.setCursor('10.0.0.5', 5000)
    expect(roster.cursorFor('10.0.0.5')).toBe(5000)
    roster.setCursor('10.0.0.5', 4000)
    expect(roster.cursorFor('10.0.0.5')).toBe(5000)
    roster.setCursor('10.0.0.5', 6000)
    expect(roster.cursorFor('10.0.0.5')).toBe(6000)
  })

  it('forgets a machine, and everything stored about it', () => {
    const roster = newRoster()
    roster.apply([entry()], DEFAULT_RULES)
    roster.setToken('10.0.0.5', 'abc123')
    expect(roster.forget('10.0.0.5')).toBe(true)
    expect(roster.tokenFor('10.0.0.5')).toBe('')
    expect(roster.size).toBe(0)
  })
})

describe('a cancelled sweep', () => {
  it('merges rather than replacing, so unreached machines stay on the wall', () => {
    const roster = newRoster()
    roster.apply(
      [entry({ ip: '10.0.0.1' }), entry({ ip: '10.0.0.2' })],
      DEFAULT_RULES
    )
    expect(roster.size).toBe(2)
    // A cancelled sweep only covered a prefix. Applying it as a full sweep
    // would read as "10.0.0.2 is no longer configured".
    roster.apply([entry({ ip: '10.0.0.1' })], DEFAULT_RULES, { partial: true })
    expect(roster.size).toBe(2)
    roster.apply([entry({ ip: '10.0.0.1' })], DEFAULT_RULES)
    expect(roster.size).toBe(1)
  })
})
