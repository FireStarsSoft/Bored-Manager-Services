/**
 * The one thing this module does that no other module does: reach machines the
 * app is not connected to.
 *
 * `ctx.exec` only ever talks to the single machine the user opened a session
 * with, so that machine becomes a jump host. One command is sent to it; that
 * command opens `maxParallel` ssh sessions of its own with `xargs -P` and pipes
 * a small script into each target's `sh -s`.
 *
 * Three properties are deliberate and must survive any edit here:
 *
 * 1. **No secret is ever an argument.** Passwords travel on the command's
 *    stdin, are written to files inside a 0700 temp directory and handed to
 *    `sshpass -f`; a sudo password is a shell variable inside the script that
 *    is piped to the target, never a word on a command line. `ps` on either
 *    machine shows nothing but flags.
 * 2. **Everything has a timeout, where the jump host allows it.** `timeout`
 *    around each ssh so one wedged machine cannot hold the batch (falling back
 *    to no per-host limit when the jump host has no `timeout` binary at all -
 *    Module settings surfaces that as a warning), and `timeoutMs` on the exec
 *    itself - which always applies, since it is enforced here rather than on
 *    the jump host - because the connection is shared with the app's own
 *    collectors. `runFanout`'s `signal` can also cut a batch short before
 *    either limit is reached, when the user cancels or the module is switched
 *    off mid-sweep.
 * 3. **Output is framed and bounded.** `xargs -P` interleaves, so each ssh
 *    writes to its own file and the frame is assembled afterwards in the order
 *    the hosts were asked. stderr is truncated: the executor puts no cap on how
 *    much a command may return.
 */
import type { ModuleContext } from '@shared/modules'
import { shQuote } from '@shared/shell'
import type { TargetRule } from './config'
import type { FleetRules } from './rules'

export interface FanoutTarget {
  ip: string
  cred: TargetRule
  /** Overrides the shared payload for this machine (an action carrying a sudo password). */
  payload?: string
}

export interface FanoutResult {
  ip: string
  /** Exit code of `timeout ssh …`: 0 is the target's own status, 124 is our timeout, 255 is ssh itself. */
  rc: number
  stdout: string
  stderr: string
}

export type Reach =
  | 'ok'
  | 'auth'
  | 'refused'
  | 'unreachable'
  | 'timeout'
  | 'hostkey'
  | 'no-sshpass'
  | 'error'

/** Frame markers, prefixed so a unit description cannot be mistaken for one. */
const FRAME = { host: '===BMHOST===', rc: '===BMRC===', out: '===BMOUT===', err: '===BMERR===' }

/**
 * Runs on the jump host, once per batch. Reads its work from stdin so that no
 * address, user name or password is visible in the process list.
 *
 * Records, tab-separated, in this order:
 *   R  maxParallel  connectTimeout  perHostTimeout  controlPersist  strict(0|1)
 *   P  b64(payload shared by every host in this batch)
 *   H  ip  port  b64(user)  auth  b64(keyPath)  b64(password)  b64(payload or empty)
 *   Z
 */
/** Exported so a test can run it under a shell with a bare environment. */
export const FANOUT_SCRIPT = String.raw`
set -u
umask 077
d=$(mktemp -d /tmp/bm-fleet.XXXXXXXX) || exit 3
trap 'rm -rf "$d"' EXIT INT TERM HUP
# A hard kill (the exec timing out) cannot run the trap, so stale directories
# from a previous run are swept here rather than left to accumulate.
find /tmp -maxdepth 1 -name 'bm-fleet.*' -mmin +5 -exec rm -rf {} + 2>/dev/null
# Control sockets have to outlive this command for ControlPersist to be worth
# anything, so they live outside $d - per user, never in a shared location.
# Read with printenv rather than the variable itself. A brace expansion with a
# default cannot be written here at all - this script is a template literal, so
# it would be substituted on the way over instead of by the shell - and a bare
# $VAR aborts the whole script under set -u when it is unset, which is normal
# on a jump host without logind (Alpine, OpenWrt, a container, UsePAM no).
# That abort reported every address in the batch as "timed out".
cm=$(printenv XDG_RUNTIME_DIR 2>/dev/null || true)
[ -n "$cm" ] || cm=$(printenv HOME 2>/dev/null || true)/.cache
cm=$cm/bm-fleet
mkdir -p "$cm" 2>/dev/null && chmod 700 "$cm" 2>/dev/null || cm="$d"
: > "$d/hosts"
: > "$d/payload"
while IFS= read -r line; do
  case "$line" in
    R*) printf '%s\n' "$line" > "$d/rules" ;;
    P*) printf '%s' "$line" | cut -f2 | base64 -d > "$d/payload" ;;
    H*) printf '%s\n' "$line" >> "$d/hosts" ;;
    Z*) break ;;
  esac
done
[ -s "$d/rules" ] || exit 4
P=$(cut -f2 "$d/rules")
CT=$(cut -f3 "$d/rules")
HT=$(cut -f4 "$d/rules")
CP=$(cut -f5 "$d/rules")
ST=$(cut -f6 "$d/rules")

cat > "$d/worker" <<'WORKER'
line="$1"; d="$2"; cm="$3"; CT="$4"; HT="$5"; CP="$6"; ST="$7"
ip=$(printf '%s' "$line" | cut -f2)
port=$(printf '%s' "$line" | cut -f3)
user=$(printf '%s' "$line" | cut -f4 | base64 -d)
auth=$(printf '%s' "$line" | cut -f5)
key=$(printf '%s' "$line" | cut -f6 | base64 -d)
printf '%s' "$line" | cut -f7 | base64 -d > "$d/p-$ip"
printf '%s' "$line" | cut -f8 | base64 -d > "$d/s-$ip"
[ -s "$d/s-$ip" ] || cp "$d/payload" "$d/s-$ip"
set -- -o ConnectTimeout="$CT" -o LogLevel=ERROR -o NumberOfPasswordPrompts=1 \
       -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -p "$port"
if [ "$CP" != "0" ]; then
  set -- "$@" -o ControlMaster=auto -o ControlPath="$cm/c-%C" -o ControlPersist="$CP"
fi
if [ "$ST" = "0" ]; then
  set -- "$@" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null
fi
# timeout is what stops one wedged machine from holding up the whole batch;
# on a jump host stripped down to just ssh/sshpass (BusyBox without coreutils)
# it may not exist. Falling back to running ssh directly - rather than letting
# the shell fail the command with "timeout: not found" - is the degraded mode
# Module settings warns about, not a hard failure; without this, every address
# in the batch used to come back misreported as "no sshpass" (rc 127 means
# whichever of the two commands after it is missing, not specifically that one).
if command -v timeout >/dev/null 2>&1; then
  run() { timeout "$HT" "$@"; }
else
  run() { "$@"; }
fi
case "$auth" in
  password)
    run sshpass -f "$d/p-$ip" ssh -o PubkeyAuthentication=no \
      -o PreferredAuthentications=password,keyboard-interactive \
      "$@" "$user@$ip" 'sh -s' < "$d/s-$ip" > "$d/o-$ip" 2> "$d/e-$ip"
    ;;
  key)
    run ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$key" \
      "$@" "$user@$ip" 'sh -s' < "$d/s-$ip" > "$d/o-$ip" 2> "$d/e-$ip"
    ;;
  *)
    run ssh -o BatchMode=yes \
      "$@" "$user@$ip" 'sh -s' < "$d/s-$ip" > "$d/o-$ip" 2> "$d/e-$ip"
    ;;
esac
printf '%s\n' "$?" > "$d/r-$ip"
# The password and the script that carried the sudo password go as soon as the
# ssh that needed them has finished.
rm -f "$d/p-$ip" "$d/s-$ip"
WORKER

# The reporting loop below only needs the addresses, so keep those separately.
# That lets the record file - which carries every host's password - be deleted
# as soon as the workers have read it, instead of living for the whole batch
# and, if the exec is hard-killed before the trap runs, until the sweep above.
cut -f2 "$d/hosts" > "$d/ips"

# -I makes xargs treat each whole line as one argument, so the tabs inside a
# record survive; @ appears nowhere else in the arguments below.
xargs -a "$d/hosts" -P "$P" -I@ sh "$d/worker" @ "$d" "$cm" "$CT" "$HT" "$CP" "$ST"
rm -f "$d/hosts"

while IFS= read -r ip; do
  printf '===BMHOST===\n%s\n===BMRC===\n%s\n===BMOUT===\n' "$ip" "$(cat "$d/r-$ip" 2>/dev/null || echo 255)"
  cat "$d/o-$ip" 2>/dev/null
  printf '===BMERR===\n'
  head -c 2000 "$d/e-$ip" 2>/dev/null
  printf '\n'
done < "$d/ips"
`

/**
 * Where the control sockets live, as the jump host's shell has to work it out.
 * Written once and used by both the fan-out script and a streamed command, so
 * the two agree on which socket to reuse.
 */
const CONTROL_DIR_EXPR = '"${XDG_RUNTIME_DIR:-$HOME/.cache}/bm-fleet"'

/**
 * One long-running ssh, for `journalctl -f`. `ctx.stream` takes a command and
 * nothing else - no stdin - so a password cannot be handed over safely here.
 * Instead this rides the multiplexed connection the last fan-out opened
 * (`ControlMaster=no` means "use the socket, do not become the master"), which
 * needs no authentication at all. `actions.ts` makes sure a master exists first.
 */
export function sshStreamCommand(target: FanoutTarget, rules: FleetRules, remote: string): string {
  const opts = [
    '-o BatchMode=yes',
    `-o ConnectTimeout=${Math.max(1, Math.trunc(rules.connectTimeoutSec))}`,
    '-o LogLevel=ERROR',
    '-o ServerAliveInterval=15',
    '-o ServerAliveCountMax=4'
  ]
  if (rules.controlPersistSec > 0) opts.push('-o ControlMaster=no', '-o ControlPath="$cm/c-%C"')
  if (!rules.strictHostKey) {
    opts.push(
      '-o StrictHostKeyChecking=no',
      '-o UserKnownHostsFile=/dev/null',
      '-o GlobalKnownHostsFile=/dev/null'
    )
  }
  if (target.cred.auth === 'key' && target.cred.keyPath) {
    opts.push('-o IdentitiesOnly=yes', `-i ${shQuote(target.cred.keyPath)}`)
  }
  const where = shQuote(`${target.cred.username}@${target.ip}`)
  return `cm=${CONTROL_DIR_EXPR}; exec ssh ${opts.join(' ')} -p ${target.cred.port} ${where} ${shQuote(remote)}`
}

function b64(value: string | undefined): string {
  return Buffer.from(value ?? '', 'utf8').toString('base64')
}

function stdinFor(targets: readonly FanoutTarget[], shared: string, rules: FleetRules): string {
  const lines = [
    [
      'R',
      Math.max(1, Math.trunc(rules.maxParallel)),
      Math.max(1, Math.trunc(rules.connectTimeoutSec)),
      Math.max(1, Math.trunc(rules.perHostTimeoutSec)),
      Math.max(0, Math.trunc(rules.controlPersistSec)),
      rules.strictHostKey ? '1' : '0'
    ].join('\t'),
    ['P', b64(shared)].join('\t')
  ]
  for (const target of targets) {
    lines.push(
      [
        'H',
        target.ip,
        target.cred.port,
        b64(target.cred.username),
        target.cred.auth,
        b64(target.cred.keyPath),
        b64(target.cred.password),
        b64(target.payload)
      ].join('\t')
    )
  }
  lines.push('Z', '')
  return lines.join('\n')
}

/** Splits the framed output back into one result per machine, in ask order. */
function parseFrames(stdout: string): FanoutResult[] {
  const out: FanoutResult[] = []
  let current: { ip: string; rc: number; body: string[]; err: string[] } | null = null
  let target: 'none' | 'rc' | 'out' | 'err' = 'none'
  const flush = (): void => {
    if (!current) return
    out.push({
      ip: current.ip,
      rc: current.rc,
      stdout: current.body.join('\n'),
      stderr: current.err.join('\n').trim()
    })
  }
  for (const line of stdout.split('\n')) {
    if (line === FRAME.host) {
      flush()
      current = { ip: '', rc: 255, body: [], err: [] }
      target = 'none'
      continue
    }
    if (!current) continue
    if (line === FRAME.rc) {
      target = 'rc'
      continue
    }
    if (line === FRAME.out) {
      target = 'out'
      continue
    }
    if (line === FRAME.err) {
      target = 'err'
      continue
    }
    if (target === 'none') current.ip = line.trim()
    else if (target === 'rc') current.rc = Number.parseInt(line.trim(), 10) || 0
    else if (target === 'out') current.body.push(line)
    else current.err.push(line)
  }
  flush()
  return out
}

/**
 * Ask every machine the same thing (or, with `target.payload`, its own thing).
 *
 * Split into batches so a long run reports progress and so one exec's output
 * stays a reasonable size; the control sockets are shared across batches, so
 * the second batch onwards reuses the connections the first one opened.
 */
export async function runFanout(
  ctx: ModuleContext,
  targets: readonly FanoutTarget[],
  sharedPayload: string,
  rules: FleetRules,
  opts?: {
    onProgress?: (done: number, total: number) => void
    cancelled?: () => boolean
    /**
     * Aborts the batch currently in flight, not just the next one.
     * `cancelled` alone is only polled between batches, so a caller that only
     * had that could stop the *next* batch from starting but not free the
     * jump host from one already running - which could hold it for the full
     * `sweepTimeoutSec` after a cancel or a module disable.
     */
    signal?: AbortSignal
  }
): Promise<FanoutResult[]> {
  if (targets.length === 0) return []
  const batchSize = Math.max(1, Math.min(Math.trunc(rules.maxParallel) * 2, 64))
  const command = `sh -c ${shQuote(FANOUT_SCRIPT)}`
  const results: FanoutResult[] = []
  for (let offset = 0; offset < targets.length; offset += batchSize) {
    if (opts?.cancelled?.() || opts?.signal?.aborted) break
    if (!ctx.connected) break
    const batch = targets.slice(offset, offset + batchSize)
    const res = await ctx.exec(command, {
      stdin: stdinFor(batch, sharedPayload, rules),
      timeoutMs: Math.max(30, Math.trunc(rules.sweepTimeoutSec)) * 1000,
      signal: opts?.signal
    })
    const parsed = parseFrames(res.stdout)
    const byIp = new Map(parsed.map((entry) => [entry.ip, entry]))
    for (const target of batch) {
      // A machine missing from the frame means the whole batch was cut short
      // (the exec timed out, the jump host ran out of something). Reporting it
      // as its own timeout is closer to the truth than dropping the row and
      // letting the card keep yesterday's green.
      results.push(
        byIp.get(target.ip) ?? {
          ip: target.ip,
          rc: 124,
          stdout: '',
          stderr: res.stderr.slice(0, 400) || 'no answer inside the sweep timeout'
        }
      )
    }
    opts?.onProgress?.(Math.min(offset + batch.length, targets.length), targets.length)
  }
  return results
}

/** What an exit code and ssh's own complaint mean, in the words a note can use. */
export function classifyReach(result: FanoutResult): Reach {
  if (result.rc === 0) return 'ok'
  const err = result.stderr.toLowerCase()
  if (result.rc === 124) return 'timeout'
  if (result.rc === 127) return 'no-sshpass'
  if (/permission denied|authentication fail|too many authentication/.test(err)) return 'auth'
  if (/host key verification failed|remote host identification has changed/.test(err)) return 'hostkey'
  if (/connection refused/.test(err)) return 'refused'
  if (/no route to host|network is unreachable|name or service not known|could not resolve/.test(err)) {
    return 'unreachable'
  }
  if (/connection timed out|operation timed out|timeout/.test(err)) return 'timeout'
  // sshpass has its own exit codes; 5 is a rejected password, 6 and 7 are host keys.
  if (result.rc === 5) return 'auth'
  if (result.rc === 6 || result.rc === 7) return 'hostkey'
  if (result.rc === 255) return 'unreachable'
  return 'error'
}

export function reachMessage(reach: Reach, result: FanoutResult): string {
  switch (reach) {
    case 'ok':
      return 'Connected.'
    case 'auth':
      return 'Reachable, but the login was refused - check the user name, key or password for this address.'
    case 'refused':
      return 'Nothing is listening on the SSH port. The machine is up but not accepting SSH.'
    case 'unreachable':
      return 'No answer at this address.'
    case 'timeout':
      return 'Timed out before the machine answered.'
    case 'hostkey':
      return "The host key did not match what is known. Clear it on the connected machine, or turn off strict host key checking in this module's rules."
    case 'no-sshpass':
      return 'The connected machine has no sshpass, so it cannot log in with a password. Install it there or use an SSH key.'
    default:
      return result.stderr.split('\n')[0] || `Failed with exit code ${result.rc}.`
  }
}
