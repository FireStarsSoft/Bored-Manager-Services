/**
 * Asking a batch of addresses whether they have an agent, and reading the
 * answer into one of five states.
 *
 * Two round trips, not one, and only for the machines that need the second:
 *
 * 1. `GET /v1/health` on every address. It needs no token, so it separates
 *    "there is an agent here" from "there is nothing here" without ever
 *    depending on whether the stored token is still good.
 * 2. `GET /v1/instances` and `GET /v1/net/status` on the ones that answered.
 *    These need the token, so this is also where `untrusted` is discovered.
 *
 * Doing health first is what makes `untrusted` a distinct state. A single
 * authenticated call would report a wrong token and a missing agent
 * identically, and the right action for those two is opposite: reinstall
 * versus install.
 */
import type { ModuleContext } from '@shared/modules'
import {
  agentReachMessage,
  classifyAgent,
  runAgentFanout,
  type AgentRequest,
  type AgentResponse
} from '../agentfan'
import type { FleetRules } from '../rules'
import { agentIsOutdated } from './manifest'
import { emptyAgent, type AgentInfo, type AgentInstance, type AgentNet, type AgentUnit } from './types'

/** One address to ask, with whatever token we have for it. */
export interface AgentTarget {
  ip: string
  port: number
  /** Empty when nothing has been stored for this machine yet. */
  token: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Read `GET /v1/instances`, defensively - this is another program's output. */
export function parseInstances(json: unknown): AgentInstance[] {
  const root = asRecord(json)
  const raw = root?.['instances']
  if (!Array.isArray(raw)) return []
  const out: AgentInstance[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const id = asString(record?.['id'])
    if (!record || !id) continue
    const units: AgentUnit[] = []
    for (const unitRaw of Array.isArray(record['units']) ? (record['units'] as unknown[]) : []) {
      const unit = asRecord(unitRaw)
      const name = asString(unit?.['name'])
      if (!unit || !name) continue
      units.push({
        name,
        state: asString(unit['state']) ?? 'unknown',
        image: asString(unit['image']),
        startedAt: asString(unit['startedAt']),
        restartCount: asNumberOrNull(unit['restartCount']) ?? 0,
        exitCode: asNumberOrNull(unit['exitCode']),
        health: asString(unit['health'])
      })
    }
    const kind = record['kind'] === 'service' ? 'service' : 'container'
    out.push({
      id,
      displayName: asString(record['displayName']) ?? id,
      kind,
      state: asString(record['state']) ?? 'unknown',
      units,
      hasCredentials: record['hasCredentials'] === true,
      templateVersion: asString(record['templateVersion']) ?? undefined,
      installedAt: asNumberOrNull(record['installedAt']),
      updatedAt: asNumberOrNull(record['updatedAt'])
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function parseNet(json: unknown): AgentNet | null {
  const record = asRecord(json)
  if (!record) return null
  return {
    online: typeof record['online'] === 'boolean' ? (record['online'] as boolean) : null,
    latencyMs: asNumberOrNull(record['latencyMs']),
    publicIp: asString(record['publicIp']),
    lastIpSource: asString(record['lastIpSource']),
    lastPingTarget: asString(record['lastPingTarget'])
  }
}

function healthVersion(response: AgentResponse): string | null {
  const record = asRecord(response.json)
  if (!record || record['service'] !== 'boredagent') return null
  return asString(record['version']) ?? '0.0.0'
}

/**
 * Ask every target, and answer for every target.
 *
 * A machine that is asked and not reported comes back `unreachable` with a
 * sentence saying so, never missing from the map - the roster reads a missing
 * entry as "unchanged", which is the one thing it must never mean here.
 */
export async function detectAgents(
  ctx: ModuleContext,
  targets: readonly AgentTarget[],
  rules: FleetRules,
  signal?: AbortSignal
): Promise<Map<string, AgentInfo>> {
  const out = new Map<string, AgentInfo>()
  if (!targets.length) return out

  const health = await runAgentFanout(
    ctx,
    targets.map((target) => ({
      ip: target.ip,
      port: target.port,
      token: target.token,
      method: 'GET',
      path: '/v1/health'
    })),
    rules,
    { signal }
  )

  const answered: AgentTarget[] = []
  const byIp = new Map(targets.map((target) => [target.ip, target]))
  for (const response of health) {
    const target = byIp.get(response.ip)
    if (!target) continue
    const reach = classifyAgent(response)
    if (reach !== 'ok' || response.status !== 200) {
      out.set(response.ip, {
        ...emptyAgent(agentReachMessage(response)),
        // A refused connection means a machine is there and nothing is
        // listening: that is "no agent", which the user can fix in one click.
        // A timeout means nothing answered at all.
        state: reach === 'refused' ? 'none' : 'unreachable'
      })
      continue
    }
    const version = healthVersion(response)
    if (version === null) {
      // Something is listening on the agent's port and is not the agent.
      out.set(response.ip, {
        ...emptyAgent('something is listening on that port, but it is not a BoredAgent'),
        state: 'none'
      })
      continue
    }
    answered.push(target)
    out.set(response.ip, {
      state: agentIsOutdated(version) ? 'outdated' : 'ready',
      version,
      message: 'answered',
      instances: [],
      net: null,
      checkedAt: Date.now()
    })
  }

  const withToken = answered.filter((target) => target.token)
  for (const target of answered) {
    if (target.token) continue
    const info = out.get(target.ip)
    if (info) {
      // An agent that is there, at a known version, that we have no token for.
      // Installing over it would work, but reinstalling to recover a token is
      // the honest description, so it reads as untrusted rather than absent.
      out.set(target.ip, {
        ...info,
        state: 'untrusted',
        message: 'an agent is running here, but this app has no token for it'
      })
    }
  }
  if (!withToken.length) return out

  const detail: AgentRequest[] = []
  for (const target of withToken) {
    detail.push({ ...target, method: 'GET', path: '/v1/instances' })
    detail.push({ ...target, method: 'GET', path: '/v1/net/status' })
  }
  const answers = await runAgentFanout(ctx, detail, rules, { signal })

  // Two requests per machine, in the order they were queued, so they come back
  // interleaved the same way.
  for (let i = 0; i < withToken.length; i++) {
    const target = withToken[i]
    const instancesResponse = answers[i * 2]
    const netResponse = answers[i * 2 + 1]
    const info = out.get(target.ip)
    if (!info) continue

    if (instancesResponse && classifyAgent(instancesResponse) === 'unauthorized') {
      out.set(target.ip, {
        ...info,
        state: 'untrusted',
        message: agentReachMessage(instancesResponse)
      })
      continue
    }
    out.set(target.ip, {
      ...info,
      instances: parseInstances(instancesResponse?.json),
      net: parseNet(netResponse?.json),
      checkedAt: Date.now()
    })
  }

  return out
}
