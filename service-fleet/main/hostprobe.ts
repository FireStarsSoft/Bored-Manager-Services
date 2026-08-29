/**
 * The small script the SSH sweep runs on every address, and how its answer is
 * read.
 *
 * It used to enumerate systemd units, which is what made a sweep expensive: a
 * machine with three hundred units returned three hundred lines, every time,
 * whether or not anything had changed. Now that everything a machine runs is
 * described by its agent over HTTP, SSH only has to answer three questions:
 *
 * - is a machine here and can we log in;
 * - what is it (hostname, distribution, kernel), for a row a person can read;
 * - is a `boredagent` unit installed, and at what version.
 *
 * That last one matters even though HTTP answers it better: when the agent's
 * port is firewalled, HTTP says `unreachable` and this says "the unit is right
 * there, enabled and running" - which is a completely different problem, and
 * the difference between "install the agent" and "open the port".
 */
import { splitSections } from '@shared/shell'

export interface HostFacts {
  hostname: string
  os: string
  kernel: string
  arch: string
  /** Whether `boredagent.service` is known to systemd here. */
  agentUnit: boolean
  /** `active`, `inactive`, `failed`, or empty when the unit is absent. */
  agentUnitState: string
  /** What `/opt/boredagent` reports, when it is installed. */
  agentVersion: string
  /** Whether Docker answers here, so a container template can be offered. */
  docker: boolean
}

/** A marker the script prints last, so a truncated answer is detectable. */
const DONE = '===BMDONE==='

/**
 * Deliberately one short script with no loops over unit lists. Everything here
 * is bounded: a machine cannot make this return more than a few hundred bytes,
 * which is what keeps a /24 sweep small.
 */
export const HOST_PROBE_SCRIPT = [
  `echo '===ID==='`,
  `hostname 2>/dev/null || true`,
  `. /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-}"`,
  `uname -r 2>/dev/null || true`,
  `uname -m 2>/dev/null || true`,
  `echo '===AGENT==='`,
  `if command -v systemctl >/dev/null 2>&1; then systemctl is-active boredagent 2>/dev/null || true; else echo none; fi`,
  `if [ -x /opt/boredagent/venv/bin/python ]; then /opt/boredagent/venv/bin/python -c 'import boredagent;print(boredagent.__version__)' 2>/dev/null || true; fi`,
  `echo '===DOCKER==='`,
  `if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo yes; else echo no; fi`,
  `echo '${DONE}'`
].join('; ')

/** Whether the answer is the whole answer, rather than a connection that dropped. */
export function probeCompleted(stdout: string): boolean {
  return stdout.includes(DONE)
}

export function parseHostProbe(stdout: string): HostFacts {
  const sections = splitSections(stdout)
  const id = (sections.get('ID') ?? '').split('\n')
  const agent = (sections.get('AGENT') ?? '').split('\n').filter((line) => line.trim())
  const docker = (sections.get('DOCKER') ?? '').trim()

  // `systemctl is-active` on a unit systemd has never heard of prints
  // `inactive` on some releases and `unknown` on others; neither means the
  // unit exists, so the version line is what actually proves an install.
  const state = (agent[0] ?? '').trim()
  const version = (agent[1] ?? '').trim()
  const known = state === 'active' || state === 'failed' || state === 'activating' || Boolean(version)

  return {
    hostname: (id[0] ?? '').trim(),
    os: (id[1] ?? '').trim(),
    kernel: (id[2] ?? '').trim(),
    arch: (id[3] ?? '').trim(),
    agentUnit: known,
    agentUnitState: known ? state : '',
    agentVersion: version,
    docker: docker === 'yes'
  }
}
