import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FANOUT_SCRIPT } from '../../service-fleet/main/fanout'
import { createTestTempDir } from '../helpers/temp-dir'

/**
 * The fan-out script runs on the jump host, not here, so nothing else in the
 * suite can tell us whether it even parses - and the one thing that broke it
 * was environmental: `set -u` plus an unset XDG_RUNTIME_DIR aborted the whole
 * script before it read a single record, and every address in the batch came
 * back as "timed out" with no hint why.
 *
 * Running it with `env -i` reproduces exactly that jump host: no logind, no
 * HOME. Skipped where there is no POSIX shell to run it in.
 */

/**
 * Whether this machine can run the script at all. Checked by running it, not
 * by looking for a path: on Windows the shell that exists is the one on PATH,
 * and `/bin/sh` is not a filesystem path Node can stat.
 */
const hasPosixShell = ((): boolean => {
  try {
    execFileSync('sh', ['-c', 'command -v env >/dev/null'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

function runWithBareEnvironment(records: string): { stdout: string; stderr: string } {
  const temp = createTestTempDir('fanout-script')
  try {
    const scriptPath = join(temp.path, 'fanout.sh')
    writeFileSync(scriptPath, FANOUT_SCRIPT, 'utf8')
    // env -i: no XDG_RUNTIME_DIR, no HOME. PATH has to stay or nothing runs.
    const stdout = execFileSync(
      'env',
      ['-i', 'PATH=/usr/bin:/bin', 'sh', scriptPath],
      { input: records, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    return { stdout, stderr: '' }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error) }
  } finally {
    temp.cleanup()
  }
}

describe('service-fleet fan-out script', () => {
  it.skipIf(!hasPosixShell)('runs under a shell with no XDG_RUNTIME_DIR or HOME', () => {
    // One host, key auth, pointed at an address nothing answers on: ssh fails,
    // which is fine - what matters is that the script got far enough to try,
    // framed the result, and did not abort on an unbound variable.
    const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
    const records = [
      ['R', '4', '1', '2', '0', '0'].join('\t'),
      ['P', b64('echo hello\n')].join('\t'),
      ['H', '127.0.0.99', '22', b64('nobody'), 'key', b64('/nonexistent/key'), '', ''].join('\t'),
      'Z'
    ].join('\n')

    const { stdout, stderr } = runWithBareEnvironment(records)

    expect(stderr).not.toMatch(/unbound variable|parameter not set/i)
    // The per-host frame is what runFanout parses; without it every address is
    // reported as a timeout regardless of what actually happened.
    expect(stdout).toContain('===BMHOST===')
    expect(stdout).toContain('127.0.0.99')
    expect(stdout).toContain('===BMRC===')
    // Its own timeout: this one really does spawn ssh and wait for a connect
    // attempt to an address nothing answers on, which takes about two seconds
    // on its own and longer than the default five while the rest of the suite
    // is running beside it.
  }, 30_000)

  it('deletes the record file holding every host password once the workers have it', () => {
    // `$d/hosts` carries a base64 password per host. It used to live for the
    // whole batch; the reporting loop now reads a list of addresses instead.
    expect(FANOUT_SCRIPT).toContain('cut -f2 "$d/hosts" > "$d/ips"')
    expect(FANOUT_SCRIPT).toContain('rm -f "$d/hosts"')
    expect(FANOUT_SCRIPT).toContain('done < "$d/ips"')
    expect(FANOUT_SCRIPT).not.toContain('done < "$d/hosts"')
  })

  it('sweeps a hard-killed run own leftovers within minutes, not an hour', () => {
    expect(FANOUT_SCRIPT).toContain("-name 'bm-fleet.*' -mmin +5")
  })

  it('falls back to running ssh without a per-host limit when the jump host has no `timeout`', () => {
    // Without this, a jump host missing `timeout` (BusyBox without coreutils)
    // hit "timeout: not found" for every address, which classifyReach used to
    // read as rc 127 -> "no sshpass" regardless of which command was actually
    // missing or what auth method was in use.
    expect(FANOUT_SCRIPT).toContain('if command -v timeout >/dev/null 2>&1; then')
    expect(FANOUT_SCRIPT).toContain('run() { timeout "$HT" "$@"; }')
    expect(FANOUT_SCRIPT).toContain('run() { "$@"; }')
    expect(FANOUT_SCRIPT).toContain('run sshpass -f "$d/p-$ip" ssh')
    expect(FANOUT_SCRIPT).toContain('run ssh -o BatchMode=yes -o IdentitiesOnly=yes')
    // No branch may still call `timeout` directly - every one goes through `run`.
    expect(FANOUT_SCRIPT).not.toMatch(/\n\s*timeout "\$HT" (sshpass|ssh)\b/)
  })
})
