/**
 * The agent release this module installs, pinned by version and hash.
 *
 * The URL lives here in TypeScript rather than in a page spec because
 * `specProblems` rejects any `http(s)://` string anywhere in a spec - modules
 * ship data, not remote references. The consequence is that installing this
 * module raises the installer's `external-url-in-code` warning, naming this
 * file. That is expected and correct: the OpenWRT module raises the same
 * warning for the same reason, and a module that downloads something should
 * have to say so at install time.
 *
 * **Why a hash and not just a tag.** A release tag can be moved, and a release
 * asset can be replaced. The sha256 is measured from a local `npm run pack` of
 * the agent and is what the jump host checks the downloaded tarball against, so
 * a swapped asset fails the install rather than silently putting different code
 * on every machine in the fleet.
 */

/** The version of `agent/pyproject.toml` this module was built against. */
export const AGENT_VERSION = '1.0.0'

/**
 * sha256 of `boredagent-<AGENT_VERSION>.tar.gz` as published.
 *
 * Measured from `npm run agent:pack`, which is byte-reproducible - the same
 * source always packs to the same bytes, so this is a property of the source
 * rather than of one build run. CI re-packs and compares before publishing.
 *
 * Left empty, the module refuses to install from the network at all and offers
 * only the upload path: downloading something it cannot check would be worse
 * than not offering it.
 */
export const AGENT_SHA256 = 'b0e80e05f701a7bb23d1d805f4316b2a8496abe7bb236b0218584d92edb913f8'

const RELEASE_BASE =
  'https://github.com/FireStarsSoft/Bored-Manager-Services/releases/download'

export function agentTarballUrl(version: string = AGENT_VERSION): string {
  return `${RELEASE_BASE}/agent-v${version}/boredagent-${version}.tar.gz`
}

export function agentTarballName(version: string = AGENT_VERSION): string {
  return `boredagent-${version}.tar.gz`
}

/** Whether a network install is possible, i.e. whether the pin is filled in. */
export function agentPinned(): boolean {
  return /^[0-9a-f]{64}$/.test(AGENT_SHA256)
}

/**
 * Compare two agent versions. Neither side is trusted to be well formed - the
 * left is what a machine reported, and a machine can report anything.
 */
export function compareAgentVersions(a: string | null, b: string): number {
  if (!a) return -1
  const left = a.split('.').map((part) => Number.parseInt(part, 10))
  const right = b.split('.').map((part) => Number.parseInt(part, 10))
  for (let i = 0; i < 3; i++) {
    const l = Number.isFinite(left[i]) ? left[i] : 0
    const r = Number.isFinite(right[i]) ? right[i] : 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/** Whether a reported version is older than the one this module ships. */
export function agentIsOutdated(reported: string | null): boolean {
  return compareAgentVersions(reported, AGENT_VERSION) < 0
}
