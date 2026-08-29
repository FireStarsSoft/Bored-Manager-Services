/**
 * Putting the agent on a machine, updating it, and taking it off again.
 *
 * This is the one thing SSH is still needed for after discovery, and the one
 * place this module runs something privileged on somebody else's machine. Three
 * decisions shape it:
 *
 * 1. **The target downloads the tarball itself**, from the pinned release URL,
 *    and checks the hash before unpacking. The alternative - the jump host
 *    downloading once and pushing the bytes to each machine - would mean
 *    base64-ing megabytes through a shell for every host in the fleet. These
 *    are machines whose whole job is having an internet connection, so asking
 *    them to fetch a tarball is not a stretch.
 * 2. **The hash is checked on the target, not here.** A check on the jump host
 *    would prove the jump host got the right bytes, which is not the question.
 * 3. **The token is read back out of the installer's own output.** The installer
 *    prints it once, on a first install, in its result block. Parsing it there
 *    is what lets the fleet manage a machine immediately instead of asking the
 *    user to go and copy a file off it.
 */
import { shQuote } from '@shared/shell'
import type { TargetRule } from '../config'
import type { FanoutResult } from '../fanout'
import { AGENT_SHA256, AGENT_VERSION, agentPinned, agentTarballName, agentTarballUrl } from './manifest'

/** What the installer's result block calls the line carrying the token. */
const TOKEN_LINE = /^Token\s*:\s*(\S+)\s*$/m
const RESULT_LINE = /^Ket qua\s*:\s*(\S+)/m

export interface InstallOutcome {
  ip: string
  ok: boolean
  /** The token, when this was a first install and the installer printed one. */
  token: string | null
  message: string
  /** The installer's own output, trimmed, for the job drawer. */
  transcript: string
}

/**
 * The privileged-command wrapper every payload here shares.
 *
 * Identical in shape to the one the module used for `systemctl`, and for the
 * same reason: the sudo password is a shell variable inside a script that
 * arrives on stdin, so it is never a word on a command line that `ps` could
 * show on either machine.
 */
function sudoPreamble(cred: TargetRule): string[] {
  const password = cred.sudo === 'sudo-password' ? (cred.sudoPassword ?? '') : ''
  return [
    `SUDO_PW=${shQuote(password)}`,
    `run() {`,
    `  if [ "$(id -u)" = 0 ]; then sh -c "$1"`,
    `  elif [ -n "$SUDO_PW" ]; then printf '%s\\n' "$SUDO_PW" | sudo -S -p '' sh -c "$1"`,
    `  else sudo -n sh -c "$1"`,
    `  fi`,
    `}`
  ]
}

/**
 * The script one machine runs to install or update the agent.
 *
 * `url` and `sha256` are parameters rather than constants so the same script
 * serves an update to a different version, and so a test can drive it without
 * reaching the network.
 */
export function installPayload(
  cred: TargetRule,
  options: { url?: string; sha256?: string; version?: string } = {}
): string {
  const url = options.url ?? agentTarballUrl(options.version)
  const sha256 = options.sha256 ?? AGENT_SHA256
  const name = agentTarballName(options.version)
  return [
    'set -u',
    'umask 077',
    ...sudoPreamble(cred),
    `d=$(mktemp -d /tmp/bm-agent-install.XXXXXXXX) || exit 3`,
    `trap 'rm -rf "$d"' EXIT INT TERM HUP`,
    `if ! command -v curl >/dev/null 2>&1; then echo "curl is not installed on this machine"; exit 4; fi`,
    `if ! command -v tar >/dev/null 2>&1; then echo "tar is not installed on this machine"; exit 4; fi`,
    `curl -fsSL --connect-timeout 15 --max-time 300 ${shQuote(url)} -o "$d/${name}" || { echo "could not download the agent"; exit 5; }`,
    // The hash is checked here, on the machine that will run the code, before
    // anything is unpacked. A mismatch stops the install rather than warning.
    `printf '%s  %s\\n' ${shQuote(sha256)} "$d/${name}" > "$d/sum"`,
    `if ! sha256sum -c "$d/sum" >/dev/null 2>&1; then echo "the downloaded agent does not match the expected sha256 - refusing to install it"; exit 6; fi`,
    `tar xzf "$d/${name}" -C "$d" || { echo "the archive could not be unpacked"; exit 7; }`,
    // The tarball unpacks to `<dir>/boredagent-<version>/install/`, so the
    // script is three levels below where it was extracted; the fourth is slack
    // for an archive that gains a wrapper. A shallower search finds nothing and
    // reports a perfectly good archive as broken - which is what maxdepth 2 did
    // until the packed tarball was actually unpacked and looked at.
    `root=$(find "$d" -maxdepth 4 -name agent-install.sh -print -quit)`,
    `[ -n "$root" ] || { echo "the archive has no agent-install.sh"; exit 8; }`,
    `run "bash '$root'" 2>&1`,
    `printf '\\n===BMINSTALLRC===%s\\n' "$?"`
  ].join('\n')
}

/** The script one machine runs to take the agent off again. */
export function uninstallPayload(cred: TargetRule, purge: boolean): string {
  return [
    'set -u',
    ...sudoPreamble(cred),
    `if [ ! -f /opt/boredagent/install/agent-install.sh ]; then`,
    // Fall back to undoing it by hand: an install that half-failed can leave a
    // unit behind without the script that would remove it, and refusing to
    // clean up in that case would leave the user with no way out from here.
    `  run "systemctl disable --now boredagent" >/dev/null 2>&1 || true`,
    `  run "rm -f /etc/systemd/system/boredagent.service /usr/local/bin/boredagent" || true`,
    `  run "systemctl daemon-reload" >/dev/null 2>&1 || true`,
    `  run "rm -rf /opt/boredagent" || true`,
    purge ? `  run "rm -rf /etc/boredagent /var/lib/boredagent" || true` : `  :`,
    `  echo "removed by hand - the installer script was not on this machine"`,
    `else`,
    `  run "bash /opt/boredagent/install/agent-install.sh ${purge ? '--purge' : '--uninstall'}" 2>&1`,
    `fi`,
    `printf '\\n===BMINSTALLRC===%s\\n' "$?"`
  ].join('\n')
}

const RC_LINE = /===BMINSTALLRC===(-?\d+)/

/**
 * Read one machine's installer output.
 *
 * The exit code is taken from the marker the payload prints rather than from
 * ssh's own, because ssh reports the exit status of the *last* command and the
 * payload has cleanup after it. The installer's own result block is the source
 * of truth for whether it worked.
 */
export function readInstall(result: FanoutResult): InstallOutcome {
  const output = `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim()
  const rcMatch = RC_LINE.exec(output)
  const rc = rcMatch ? Number.parseInt(rcMatch[1], 10) : result.rc
  const transcript = output.replace(RC_LINE, '').trim().slice(-4000)
  const verdict = RESULT_LINE.exec(transcript)?.[1]
  const token = TOKEN_LINE.exec(transcript)?.[1] ?? null

  if (result.rc === 255) {
    return { ip: result.ip, ok: false, token: null, message: 'could not connect over SSH', transcript }
  }
  if (result.rc === 124) {
    return { ip: result.ip, ok: false, token: null, message: 'the install timed out', transcript }
  }

  // The installer's own word beats the exit code: a preflight that refused is
  // an orderly FAILED with a reason, and reporting it as "exit 1" would throw
  // away the fourteen lines that say which check stopped it.
  if (verdict === 'SUCCESS') {
    return {
      ip: result.ip,
      ok: true,
      token,
      message: token ? 'installed, token captured' : 'installed (an existing token was kept)',
      transcript
    }
  }
  if (verdict === 'FAILED') {
    const step = /\(buoc:\s*([^)]+)\)/.exec(transcript)?.[1]
    return {
      ip: result.ip,
      ok: false,
      token: null,
      message: step ? `the installer stopped at ${step}` : 'the installer reported FAILED',
      transcript
    }
  }

  const firstLine = transcript.split('\n').find((line) => line.trim()) ?? ''
  return {
    ip: result.ip,
    ok: rc === 0,
    token,
    message: rc === 0 ? 'finished' : firstLine.slice(0, 200) || `exited ${rc}`,
    transcript
  }
}

/** Why an install cannot even be attempted, or null when it can. */
export function installBlocked(uploadProvided: boolean): string | null {
  if (uploadProvided || agentPinned()) return null
  return (
    `This build of the module has no published agent to install: the ${AGENT_VERSION} release has not been ` +
    'hashed into it yet. Upload the agent tarball on this page instead, and it will be checked against the ' +
    'hash you give with it.'
  )
}
