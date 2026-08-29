/**
 * What this module knows about one agent, and the words it says it in.
 *
 * `AgentState` is the whole vocabulary of the Machines page's agent column and
 * the fleet wall's card colour, so it is worth being precise about what each
 * one means - most of the module's UI copy is written against these five.
 */

/**
 * - `none`        SSH works and there is no agent. The one state with a
 *                 one-click answer, which is why it is orange rather than red.
 * - `outdated`    An agent answered, at a version older than the one this
 *                 module ships. It still works; it is worth updating.
 * - `ready`       An agent answered at the pinned version, with a token that
 *                 was accepted.
 * - `untrusted`   An agent answered and refused the stored token. Reinstalling
 *                 is the fix; this is deliberately not `none`, because
 *                 installing over it would be the wrong move.
 * - `unreachable` Nothing answered. Either the machine is down or the port is
 *                 blocked, and the two cannot be told apart from here.
 */
export type AgentState = 'none' | 'outdated' | 'ready' | 'untrusted' | 'unreachable'

/** One unit inside an instance, as the agent describes it. */
export interface AgentUnit {
  name: string
  state: string
  image?: string | null
  startedAt?: string | null
  restartCount?: number
  exitCode?: number | null
  health?: string | null
}

/** One template installed on one machine. */
export interface AgentInstance {
  id: string
  displayName: string
  kind: 'container' | 'service'
  state: string
  units: AgentUnit[]
  hasCredentials: boolean
  templateVersion?: string
  installedAt?: number | null
  updatedAt?: number | null
}

/** What one agent reported on the last poll. */
export interface AgentInfo {
  state: AgentState
  /** The agent's own version, when it answered. */
  version: string | null
  /** One sentence saying why it is in that state. */
  message: string
  /** Instances the agent is running. Empty for every state but `ready`. */
  instances: AgentInstance[]
  /** The agent's live network reading, for the fleet's public-IP grouping. */
  net: AgentNet | null
  checkedAt: number
}

export interface AgentNet {
  online: boolean | null
  latencyMs: number | null
  publicIp: string | null
  lastIpSource: string | null
  lastPingTarget: string | null
}

export function emptyAgent(message: string): AgentInfo {
  return {
    state: 'unreachable',
    version: null,
    message,
    instances: [],
    net: null,
    checkedAt: Date.now()
  }
}

/** Whether this module can act on the agent at all. */
export function agentUsable(info: AgentInfo | null): boolean {
  return info?.state === 'ready' || info?.state === 'outdated'
}
