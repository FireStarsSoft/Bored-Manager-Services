/**
 * The scripts that run **on the monitored machines** and the parsers for what
 * they say back.
 *
 * Everything is one `sh` script piped to `sh -s`, so it works whatever login
 * shell the account has, and it never writes anything on the target: a sweep
 * only reads, and an action only calls `systemctl`.
 *
 * Output is `key=value` lines inside `===NAME===` sections rather than fixed
 * line positions, because a machine with no `hostname` binary would otherwise
 * shift every field after it by one line.
 */
import { shQuote, splitSections } from '@shared/shell'
import type { SudoMode, TargetRule, WatchedUnit } from './config'
import type { FleetRules } from './rules'

export interface UnitState {
  unit: string
  /** `loaded`, `not-found`, `masked`, `error`. */
  load: string
  /** `active`, `inactive`, `failed`, `activating`, `deactivating`. */
  active: string
  /** `running`, `dead`, `exited`, `failed`, `start-pre`. */
  sub: string
  /** `enabled`, `disabled`, `static`, `masked`, or empty when there is no unit file. */
  fileState: string
  description: string
}

export interface HostFacts {
  hostname: string
  os: string
  systemd: boolean
  /** 0 when the account is root, so no sudo is needed at all. */
  uid: number
  /** First package manager found: `apt-get`, `dnf`, `yum`, `zypper`, `pacman`, `apk`, or empty. */
  pkg: string
  kernel: string
  uptimeSec: number
  /** Whether `sudo -n true` worked, i.e. control needs no password. */
  sudoNoPassword: boolean
  /** From `list-units`: what is running (and what has failed), per `unitScope`. */
  units: UnitState[]
  /** From `systemctl show`: one entry per watched unit asked about, installed or not. */
  watched: UnitState[]
  truncated: boolean
}

export const UNIT_ACTIONS = [
  'start',
  'stop',
  'restart',
  'reload',
  'enable',
  'disable',
  'mask',
  'unmask'
] as const

export type UnitAction = (typeof UNIT_ACTIONS)[number]

/** Actions that take something away rather than add it. */
export const DESTRUCTIVE_ACTIONS: readonly UnitAction[] = ['stop', 'disable', 'mask']

const UNIT_NAME_RE = /^[A-Za-z0-9@:_.-]+\.(service|socket|timer|target|path|mount|slice|scope)$/

export function isUnitAction(value: unknown): value is UnitAction {
  return typeof value === 'string' && (UNIT_ACTIONS as readonly string[]).includes(value)
}

/**
 * Every unit name is checked before it is quoted into a command. `shQuote` is
 * what actually makes it safe; this is what makes the refusal say why.
 */
export function isValidUnit(unit: string): boolean {
  return unit.length > 0 && unit.length <= 128 && UNIT_NAME_RE.test(unit)
}

const STEP_FRAME = { step: '===BMSTEP===', say: '===BMSAY===' }

/** The read-only sweep, identical for every machine in a batch. */
export function sweepPayload(watched: readonly WatchedUnit[], rules: FleetRules): string {
  const names = [...new Set(watched.map((w) => w.unit).filter(isValidUnit))]
  const lines = [
    `echo '===ID==='`,
    `printf 'host=%s\\n' "$(hostname 2>/dev/null)"`,
    `printf 'os=%s\\n' "$( . /etc/os-release 2>/dev/null; printf '%s' "\${PRETTY_NAME:-}" )"`,
    `if command -v systemctl >/dev/null 2>&1; then echo 'init=systemd'; else echo 'init=other'; fi`,
    `printf 'uid=%s\\n' "$(id -u 2>/dev/null)"`,
    `printf 'kernel=%s\\n' "$(uname -r 2>/dev/null)"`,
    `printf 'uptime=%s\\n' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
    `for m in apt-get dnf yum zypper pacman apk; do if command -v "$m" >/dev/null 2>&1; then printf 'pkg=%s\\n' "$m"; break; fi; done`,
    `if sudo -n true 2>/dev/null; then echo 'sudo=yes'; else echo 'sudo=no'; fi`
  ]
  if (rules.unitScope !== 'watched') {
    // `failed` is asked for alongside `running` on purpose: a unit that died is
    // the whole reason to look at this page, and --state=running hides it.
    const state = rules.unitScope === 'all' ? '--all' : '--state=running,failed'
    lines.push(
      `echo '===UNITS==='`,
      `systemctl list-units --type=service ${state} --plain --no-legend --no-pager 2>/dev/null | head -n ${Math.max(10, Math.trunc(rules.maxUnitsPerHost))}`
    )
  }
  if (names.length) {
    lines.push(
      `echo '===WATCHED==='`,
      `systemctl show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p Description ${names
        .map(shQuote)
        .join(' ')} 2>/dev/null`
    )
  }
  lines.push(`echo '===END==='`)
  return lines.join('\n') + '\n'
}

function parseIdSection(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** `UNIT LOAD ACTIVE SUB DESCRIPTION`, five columns, the last one with spaces in it. */
function parseListUnits(text: string, cap: number): { units: UnitState[]; truncated: boolean } {
  const units: UnitState[] = []
  let truncated = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 4) continue
    if (units.length >= cap) {
      truncated = true
      break
    }
    units.push({
      unit: parts[0],
      load: parts[1],
      active: parts[2],
      sub: parts[3],
      fileState: '',
      description: parts.slice(4).join(' ')
    })
  }
  return { units, truncated }
}

/** `systemctl show` prints one block of `Key=Value` per unit, blocks split by a blank line. */
function parseShow(text: string): UnitState[] {
  const out: UnitState[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const props = parseIdSection(block)
    const unit = props['Id']
    if (!unit) continue
    out.push({
      unit,
      load: props['LoadState'] ?? '',
      active: props['ActiveState'] ?? '',
      sub: props['SubState'] ?? '',
      fileState: props['UnitFileState'] ?? '',
      description: props['Description'] ?? ''
    })
  }
  return out
}

export function parseSweep(stdout: string, cap: number): HostFacts {
  const sections = splitSections(stdout)
  const id = parseIdSection(sections.get('ID') ?? '')
  const listed = parseListUnits(sections.get('UNITS') ?? '', cap)
  const uptime = Number.parseFloat(id['uptime'] ?? '')
  return {
    hostname: id['host'] ?? '',
    os: id['os'] ?? '',
    systemd: id['init'] === 'systemd',
    uid: Number.parseInt(id['uid'] ?? '', 10),
    pkg: id['pkg'] ?? '',
    kernel: id['kernel'] ?? '',
    uptimeSec: Number.isFinite(uptime) ? Math.trunc(uptime) : 0,
    sudoNoPassword: id['sudo'] === 'yes',
    units: listed.units,
    watched: parseShow(sections.get('WATCHED') ?? ''),
    truncated: listed.truncated
  }
}

/** Did the sweep script get far enough to be trusted? */
export function sweepCompleted(stdout: string): boolean {
  return stdout.includes('===END===')
}

export interface Step {
  /** What the step is about, echoed back so a result can be matched to a row. */
  name: string
  command: string
}

/**
 * A privileged payload. The sudo password is a shell variable inside a script
 * that is piped to the target, so it is neither an argument on the jump host
 * nor an argument on the target - `printf | sudo -S` keeps it off both process
 * lists.
 */
export function actionPayload(steps: readonly Step[], cred: TargetRule): string {
  const password = cred.sudo === 'sudo-password' ? (cred.sudoPassword ?? '') : ''
  const lines = [
    `SUDO_PW=${shQuote(password)}`,
    `run() {`,
    `  if [ "$(id -u)" = 0 ]; then sh -c "$1"`,
    `  elif [ -n "$SUDO_PW" ]; then printf '%s\\n' "$SUDO_PW" | sudo -S -p '' sh -c "$1"`,
    `  else sudo -n sh -c "$1"`,
    `  fi`,
    `}`
  ]
  for (const step of steps) {
    lines.push(
      `out=$(run ${shQuote(step.command)} 2>&1); rc=$?`,
      `out=$(printf '%s' "$out" | head -c 600)`,
      `printf '${STEP_FRAME.step}\\nname=%s\\nrc=%s\\n${STEP_FRAME.say}\\n%s\\n' ${shQuote(step.name)} "$rc" "$out"`
    )
  }
  return lines.join('\n') + '\n'
}

export interface StepResult {
  name: string
  rc: number
  say: string
}

export function parseSteps(stdout: string): StepResult[] {
  const out: StepResult[] = []
  let current: { name: string; rc: number; say: string[] } | null = null
  let inSay = false
  const flush = (): void => {
    if (current) out.push({ name: current.name, rc: current.rc, say: current.say.join('\n').trim() })
  }
  for (const line of stdout.split('\n')) {
    if (line === STEP_FRAME.step) {
      flush()
      current = { name: '', rc: 0, say: [] }
      inSay = false
      continue
    }
    if (!current) continue
    if (line === STEP_FRAME.say) {
      inSay = true
      continue
    }
    if (inSay) {
      current.say.push(line)
      continue
    }
    if (line.startsWith('name=')) current.name = line.slice(5).trim()
    else if (line.startsWith('rc=')) current.rc = Number.parseInt(line.slice(3).trim(), 10) || 0
  }
  flush()
  return out
}

/** `systemctl <action> <unit>`, with `--now` where it makes the action mean what the label says. */
export function unitCommand(action: UnitAction, unit: string): string {
  const quoted = shQuote(unit)
  if (action === 'enable') return `systemctl enable --now ${quoted}`
  if (action === 'disable') return `systemctl disable --now ${quoted}`
  if (action === 'mask') return `systemctl mask --now ${quoted}`
  return `systemctl ${action} ${quoted}`
}

/** Whether a machine can be controlled at all, given what the rule says about sudo. */
export function canControl(facts: HostFacts | null, sudo: SudoMode): boolean {
  if (!facts) return false
  if (facts.uid === 0) return true
  if (sudo === 'sudo-password') return true
  if (sudo === 'sudo-n') return facts.sudoNoPassword
  return false
}
