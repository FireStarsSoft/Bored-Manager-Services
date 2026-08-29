/**
 * Reaching agents over HTTP, by running `curl` on the jump host.
 *
 * Once a machine has an agent, SSH stops being the right way to talk to it: the
 * agent already exposes everything this module needs on port 8741, and an HTTP
 * round trip is a fraction of the cost of opening an SSH session, running a
 * shell and tearing it down. `fanout.ts` stays for the things only SSH can do -
 * finding machines, and putting the agent there in the first place.
 *
 * The three properties `fanout.ts` documents apply here unchanged, and are worth
 * restating because the failure modes are the same:
 *
 * 1. **No secret is ever an argument.** A bearer token on a command line is
 *    visible in `ps` to every user on the jump host, for as long as the request
 *    takes. Each target's options - including `header = "Authorization: ..."` -
 *    go into a file inside a 0700 mktemp directory and are handed to
 *    `curl --config`, which is the exact analogue of `sshpass -f`.
 * 2. **Everything has a timeout.** `--connect-timeout` and `--max-time` per
 *    request so one wedged agent cannot hold the batch, plus `timeoutMs` on the
 *    exec itself, which is enforced here rather than on the jump host.
 * 3. **Output is framed and bounded.** `xargs -P` interleaves, so each request
 *    writes its own files and the frame is assembled afterwards in ask order.
 *    Bodies are truncated: an agent is trusted to be ours, not to be sane.
 */
import type { ModuleContext } from '@shared/modules'
import type { FleetRules } from './rules'

/** One agent to ask, and what to ask it. */
export interface AgentRequest {
  ip: string
  port: number
  token: string
  /** `GET`, `POST`, `PUT` or `DELETE`. */
  method: string
  /** Path including any query string, e.g. `/v1/instances/honeygain/logs?tail=50`. */
  path: string
  /** JSON body for POST/PUT. */
  body?: unknown
}

export interface AgentResponse {
  ip: string
  /** HTTP status, or 0 when curl never got one. */
  status: number
  /** curl's own exit code: 0 ok, 7 refused, 28 timed out, 6 DNS. */
  curlCode: number
  body: string
  /** Parsed `body`, when it was JSON. */
  json?: unknown
  error?: string
}

/** Why an agent did not answer, in the vocabulary the roster colours by. */
export type AgentReach = 'ok' | 'unauthorized' | 'refused' | 'timeout' | 'error'

/** Frame markers, prefixed so a log line cannot be mistaken for one. */
const FRAME = {
  req: '===BMAREQ===',
  host: '===BMAHOST===',
  code: '===BMACODE===',
  status: '===BMASTATUS===',
  body: '===BMABODY==='
}

/** Bodies larger than this are truncated - a log tail is the biggest legitimate one. */
const MAX_BODY_BYTES = 512 * 1024

/**
 * Runs on the jump host, once per batch. Reads its work from stdin so that no
 * address and no token is visible in the process list.
 *
 * Records, tab-separated, in this order:
 *   R  maxParallel  connectTimeout  perRequestTimeout
 *   A  index  ip  port  method  b64(path)  b64(token)  b64(body or empty)
 *   Z
 *
 * **A request is identified by its index, not by its address.** One batch
 * routinely asks the same machine two things - the daily rollups and the
 * incidents - and keying anything by address would collapse those two into
 * whichever answered last. Every temporary file and every frame therefore
 * carries the index.
 */
export const AGENTFAN_SCRIPT = String.raw`
set -u
umask 077
d=$(mktemp -d /tmp/bm-agent.XXXXXXXX) || exit 3
trap 'rm -rf "$d"' EXIT INT TERM HUP
# A hard kill (the exec timing out) cannot run the trap, so stale directories
# from a previous run are swept here rather than left to accumulate. They hold
# tokens, so this is not merely tidiness.
find /tmp -maxdepth 1 -name 'bm-agent.*' -mmin +5 -exec rm -rf {} + 2>/dev/null
: > "$d/reqs"
while IFS= read -r line; do
  case "$line" in
    R*) printf '%s\n' "$line" > "$d/rules" ;;
    A*) printf '%s\n' "$line" >> "$d/reqs" ;;
    Z*) break ;;
  esac
done
[ -s "$d/rules" ] || exit 4
P=$(cut -f2 "$d/rules")
CT=$(cut -f3 "$d/rules")
MT=$(cut -f4 "$d/rules")

cat > "$d/worker" <<'WORKER'
line="$1"; d="$2"; CT="$3"; MT="$4"
i=$(printf '%s' "$line" | cut -f2)
ip=$(printf '%s' "$line" | cut -f3)
port=$(printf '%s' "$line" | cut -f4)
method=$(printf '%s' "$line" | cut -f5)
path=$(printf '%s' "$line" | cut -f6 | base64 -d)
token=$(printf '%s' "$line" | cut -f7 | base64 -d)
printf '%s' "$line" | cut -f8 | base64 -d > "$d/b-$i"

# Everything sensitive goes in the config file rather than on the command line.
# curl reads it before it makes the request and it is deleted immediately after.
{
  printf 'silent\n'
  printf 'show-error\n'
  printf 'connect-timeout = %s\n' "$CT"
  printf 'max-time = %s\n' "$MT"
  printf 'request = "%s"\n' "$method"
  printf 'header = "Authorization: Bearer %s"\n' "$token"
  printf 'header = "Accept: application/json"\n'
  printf 'write-out = "\n%%{http_code}"\n'
  if [ -s "$d/b-$i" ]; then
    printf 'header = "Content-Type: application/json"\n'
    printf 'data-binary = "@%s"\n' "$d/b-$i"
  fi
  printf 'url = "http://%s:%s%s"\n' "$ip" "$port" "$path"
} > "$d/c-$i"

curl --config "$d/c-$i" > "$d/o-$i" 2> "$d/e-$i"
printf '%s\n' "$?" > "$d/r-$i"
rm -f "$d/c-$i" "$d/b-$i"
WORKER

cut -f2,3 "$d/reqs" > "$d/index"
xargs -a "$d/reqs" -P "$P" -I@ sh "$d/worker" @ "$d" "$CT" "$MT"
rm -f "$d/reqs"

while IFS='	' read -r i ip; do
  code=$(cat "$d/r-$i" 2>/dev/null || echo 255)
  # write-out appended the status on its own final line; split it back off.
  status=$(tail -n 1 "$d/o-$i" 2>/dev/null)
  case "$status" in
    ''|*[!0-9]*) status=0 ;;
  esac
  printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    "===BMAREQ===" "$i" "===BMAHOST===" "$ip" "===BMACODE===" "$code" "===BMASTATUS===" "$status"
  printf '===BMABODY===\n'
  if [ "$code" = "0" ]; then
    head -c 524288 "$d/o-$i" 2>/dev/null | sed '$d'
  else
    head -c 2000 "$d/e-$i" 2>/dev/null
  fi
  printf '\n'
done < "$d/index"
`

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

/** What curl's exit code and the HTTP status together mean. */
export function classifyAgent(response: AgentResponse): AgentReach {
  if (response.curlCode === 0) {
    if (response.status === 401 || response.status === 403) return 'unauthorized'
    if (response.status >= 200 && response.status < 500) return 'ok'
    return 'error'
  }
  switch (response.curlCode) {
    case 7:
      // Connection refused: something is at that address and nothing is
      // listening on 8741. Almost always "the agent is not installed".
      return 'refused'
    case 28:
      return 'timeout'
    default:
      return 'error'
  }
}

/** A sentence for a user, from the same pair. */
export function agentReachMessage(response: AgentResponse): string {
  const reach = classifyAgent(response)
  switch (reach) {
    case 'ok':
      return response.status >= 400
        ? `the agent answered ${response.status}`
        : 'answered'
    case 'unauthorized':
      return 'the agent refused the stored token - reinstall it, or clear the machine and install again'
    case 'refused':
      return 'nothing is listening on that port - the agent is probably not installed'
    case 'timeout':
      return 'the agent did not answer in time'
    default:
      return response.error?.trim() || `curl exited ${response.curlCode}`
  }
}

function parseFrames(stdout: string, asked: readonly AgentRequest[]): AgentResponse[] {
  const byIndex = new Map<number, AgentResponse>()
  for (const chunk of stdout.split(FRAME.req).slice(1)) {
    const [indexPart, rest0] = splitOnce(chunk, FRAME.host)
    const [ipPart, rest1] = splitOnce(rest0, FRAME.code)
    const [codePart, rest2] = splitOnce(rest1, FRAME.status)
    const [statusPart, bodyPart] = splitOnce(rest2, FRAME.body)
    const index = Number.parseInt(indexPart.trim(), 10)
    if (!Number.isInteger(index)) continue
    const body = bodyPart.replace(/\n$/, '')
    const response: AgentResponse = {
      ip: ipPart.trim(),
      curlCode: Number.parseInt(codePart.trim(), 10) || 0,
      status: Number.parseInt(statusPart.trim(), 10) || 0,
      body: body.length > MAX_BODY_BYTES ? body.slice(0, MAX_BODY_BYTES) : body
    }
    if (response.curlCode !== 0) response.error = body.trim()
    else response.json = tryJson(response.body)
    byIndex.set(index, response)
  }
  // A request the jump host never reported - the exec was cut short, or the
  // script died before its reporting loop. Saying nothing about it would leave
  // the roster showing yesterday's state as though it were current.
  return asked.map(
    (request, index) =>
      byIndex.get(index) ?? {
        ip: request.ip,
        curlCode: 255,
        status: 0,
        body: '',
        error: 'the jump host did not report this request'
      }
  )
}

function splitOnce(text: string, marker: string): [string, string] {
  const index = text.indexOf(marker)
  if (index === -1) return [text, '']
  return [text.slice(0, index), text.slice(index + marker.length)]
}

function tryJson(body: string): unknown {
  const trimmed = body.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

export interface AgentFanoutOptions {
  signal?: AbortSignal
  /** Overrides the rules' own per-batch ceiling, for one long call. */
  timeoutMs?: number
}

/**
 * Ask several agents at once. One `ctx.exec`, whatever the batch size.
 *
 * Answers in the order asked, with an entry for every request even when the
 * jump host reported nothing - a missing row would read as "unchanged" to the
 * roster, which is the one thing it must never mean.
 */
export async function runAgentFanout(
  ctx: ModuleContext,
  requests: readonly AgentRequest[],
  rules: FleetRules,
  options: AgentFanoutOptions = {}
): Promise<AgentResponse[]> {
  if (!requests.length) return []

  const parallel = Math.max(1, Math.trunc(rules.maxParallel))
  const connect = Math.max(1, Math.trunc(rules.connectTimeoutSec))
  const perRequest = Math.max(connect, Math.trunc(rules.perHostTimeoutSec))

  const lines: string[] = [`R\t${parallel}\t${connect}\t${perRequest}`]
  requests.forEach((request, index) => {
    lines.push(
      [
        'A',
        String(index),
        request.ip,
        String(Math.max(1, Math.trunc(request.port))),
        request.method.toUpperCase(),
        b64(request.path),
        b64(request.token),
        b64(request.body === undefined ? '' : JSON.stringify(request.body))
      ].join('\t')
    )
  })
  lines.push('Z')

  // The batch ceiling has to allow for every wave: `parallel` at a time, each
  // able to take `perRequest`. Without the wave count a large sweep is cut off
  // by its own timeout and every unreported address reads as a failure.
  const waves = Math.ceil(requests.length / parallel)
  const ceiling = options.timeoutMs ?? (connect + perRequest * waves) * 1000 + 5000

  const result = await ctx.exec(AGENTFAN_SCRIPT, {
    stdin: `${lines.join('\n')}\n`,
    timeoutMs: ceiling,
    signal: options.signal
  })

  return parseFrames(result.stdout ?? '', requests)
}

/** The common case: ask one agent one thing. */
export async function askAgent(
  ctx: ModuleContext,
  request: AgentRequest,
  rules: FleetRules,
  options: AgentFanoutOptions = {}
): Promise<AgentResponse> {
  const [response] = await runAgentFanout(ctx, [request], rules, options)
  return response ?? { ip: request.ip, curlCode: 255, status: 0, body: '', error: 'no answer' }
}
