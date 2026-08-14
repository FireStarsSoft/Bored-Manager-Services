/**
 * What the machine the app is connected to can actually do for us. This module
 * reaches other machines by running `ssh` **on** that machine, so if it has no
 * ssh client there is nothing to fall back to - and the settings page has to
 * say that plainly instead of showing an empty table of results.
 */
import type { ModuleContext } from '@shared/modules'
import { splitSections } from '@shared/shell'

export interface JumpCapabilities {
  t: number
  connected: boolean
  ssh: boolean
  sshpass: boolean
  xargs: boolean
  base64: boolean
  timeout: boolean
  mktemp: boolean
  nc: boolean
  sshVersion: string
  /** Non-null when the module cannot work at all from here. */
  problem: string | null
}

const TOOLS = ['ssh', 'sshpass', 'xargs', 'base64', 'timeout', 'mktemp', 'nc'] as const

const PROBE_SCRIPT = [
  `echo '===TOOLS==='`,
  `for t in ${TOOLS.join(' ')}; do if command -v "$t" >/dev/null 2>&1; then echo "$t=yes"; else echo "$t=no"; fi; done`,
  `echo '===VERSION==='`,
  `ssh -V 2>&1 | head -n 1`
].join('; ')

export function emptyCapabilities(): JumpCapabilities {
  return {
    t: Date.now(),
    connected: false,
    ssh: false,
    sshpass: false,
    xargs: false,
    base64: false,
    timeout: false,
    mktemp: false,
    nc: false,
    sshVersion: '',
    problem: 'Not connected to a machine yet.'
  }
}

export async function probeJumpHost(ctx: ModuleContext): Promise<JumpCapabilities> {
  if (!ctx.connected) return emptyCapabilities()
  const res = await ctx.exec(PROBE_SCRIPT, { timeoutMs: 15000 })
  const sections = splitSections(res.stdout)
  const found = new Set(
    (sections.get('TOOLS') ?? '')
      .split('\n')
      .filter((line) => line.trim().endsWith('=yes'))
      .map((line) => line.split('=')[0].trim())
  )
  const out: JumpCapabilities = {
    t: Date.now(),
    connected: true,
    ssh: found.has('ssh'),
    sshpass: found.has('sshpass'),
    xargs: found.has('xargs'),
    base64: found.has('base64'),
    timeout: found.has('timeout'),
    mktemp: found.has('mktemp'),
    nc: found.has('nc'),
    sshVersion: (sections.get('VERSION') ?? '').trim().split('\n')[0] ?? '',
    problem: null
  }
  const missing = (['ssh', 'xargs', 'base64', 'mktemp'] as const).filter((tool) => !out[tool])
  if (missing.length) {
    out.problem = `The connected machine has no ${missing.join(', ')}. Install openssh-client and coreutils on it, or connect to a machine that has them.`
  } else if (!out.timeout) {
    out.problem =
      'The connected machine has no `timeout`, so one unresponsive machine can hold a sweep until the whole command times out.'
  }
  return out
}
