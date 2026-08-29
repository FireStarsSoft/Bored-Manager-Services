import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENTFAN_SCRIPT,
  agentReachMessage,
  classifyAgent,
  type AgentResponse
} from '../../service-fleet/main/agentfan'

/**
 * The HTTP fan-out, run under a real shell with a fake `curl`.
 *
 * The script is what carries every agent token onto the jump host, so the
 * properties worth proving are about what it does *not* do: no token on a
 * command line, no config file left behind, and an answer for every address it
 * was asked about even when one of them fails.
 *
 * A stub `curl` on PATH is what makes that testable without a network - and it
 * doubles as the assertion, because it records the arguments it was given.
 *
 * Skipped where there is no POSIX shell to run it in, the same way the SSH
 * fan-out's own script test is.
 */
const hasPosixShell = ((): boolean => {
  try {
    execFileSync('sh', ['-c', 'command -v env >/dev/null'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()
describe('AGENTFAN_SCRIPT under a real shell', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function stubCurl(body: string, exitCode = 0): { bin: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'bm-agentfan-'))
    dirs.push(dir)
    const log = join(dir, 'argv.log')
    const script = join(dir, 'curl')
    // Records its own arguments and the config file it was handed, then
    // answers with a canned body plus the status write-out appends.
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        'for a in "$@"; do',
        '  case "$a" in',
        `    /*) [ -f "$a" ] && cat "$a" >> ${JSON.stringify(log)} ;;`,
        '  esac',
        'done',
        `printf '%s' ${JSON.stringify(body)}`,
        "printf '\\n200'",
        `exit ${exitCode}`
      ].join('\n'),
      { mode: 0o755 }
    )
    chmodSync(script, 0o755)
    return { bin: dir, log }
  }

  function fanout(stdin: string, bin: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'bm-agentfan-run-'))
    dirs.push(dir)
    const scriptPath = join(dir, 'agentfan.sh')
    writeFileSync(scriptPath, AGENTFAN_SCRIPT, 'utf8')
    return execFileSync('sh', [scriptPath], {
      input: stdin,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
    })
  }

  const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

  it.skipIf(!hasPosixShell)('frames one answer per address, in the order asked', () => {
    const { bin } = stubCurl('{"ok":true}')
    const stdin = [
      'R\t4\t5\t20',
      `A\t0\t10.0.0.1\t8741\tGET\t${b64('/v1/health')}\t${b64('tok-a')}\t${b64('')}`,
      `A\t1\t10.0.0.2\t8741\tGET\t${b64('/v1/health')}\t${b64('tok-b')}\t${b64('')}`,
      'Z',
      ''
    ].join('\n')
    const out = fanout(stdin, bin)
    expect(out).toContain('===BMAHOST===\n10.0.0.1')
    expect(out).toContain('===BMAREQ===\n0')
    expect(out).toContain('===BMAHOST===\n10.0.0.2')
    expect(out).toContain('{"ok":true}')
    // The status write-out is split back off rather than left in the body.
    expect(out).toContain('===BMASTATUS===\n200')
  })

  it.skipIf(!hasPosixShell)('never puts a token on a command line', () => {
    const { bin, log } = stubCurl('{}')
    const stdin = [
      'R\t2\t5\t20',
      `A\t0\t10.0.0.9\t8741\tGET\t${b64('/v1/instances')}\t${b64('super-secret-token')}\t${b64('')}`,
      'Z',
      ''
    ].join('\n')
    fanout(stdin, bin)
    const recorded = readFileSync(log, 'utf8')
    const [argvLine] = recorded.split('\n')
    // The arguments carry only --config and a path; the token reaches curl
    // through that file, which is what keeps it out of `ps`.
    expect(argvLine).toContain('--config')
    expect(argvLine).not.toContain('super-secret-token')
    // It is in the config file, which is the whole point of using one.
    expect(recorded).toContain('super-secret-token')
  })

  it.skipIf(!hasPosixShell)('leaves nothing behind, so a token cannot outlive the batch', () => {
    const { bin } = stubCurl('{}')
    const stdin = [
      'R\t1\t5\t20',
      `A\t0\t10.0.0.3\t8741\tGET\t${b64('/v1/health')}\t${b64('tok')}\t${b64('')}`,
      'Z',
      ''
    ].join('\n')
    // Counted around this one run rather than asserting /tmp is globally
    // empty: other tests and other processes leave their own directories
    // there, and a test that fails because of one of those teaches nothing.
    const count = (): number => {
      const out = execFileSync('sh', ['-c', 'ls -d /tmp/bm-agent.* 2>/dev/null | wc -l'], {
        encoding: 'utf8'
      })
      return Number.parseInt(out.trim(), 10) || 0
    }
    const before = count()
    fanout(stdin, bin)
    expect(count()).toBe(before)
  })

  it.skipIf(!hasPosixShell)('still reports an address whose request failed', () => {
    const { bin } = stubCurl('could not connect', 7)
    const stdin = [
      'R\t1\t5\t20',
      `A\t0\t10.0.0.4\t8741\tGET\t${b64('/v1/health')}\t${b64('tok')}\t${b64('')}`,
      'Z',
      ''
    ].join('\n')
    const out = fanout(stdin, bin)
    expect(out).toContain('10.0.0.4')
    expect(out).toContain('===BMACODE===\n7')
  })

  it.skipIf(!hasPosixShell)('runs with a bare environment, as a jump host without logind provides', () => {
    const { bin } = stubCurl('{}')
    const stdin = ['R\t1\t5\t20', `A\t0\t10.0.0.5\t8741\tGET\t${b64('/v1/health')}\t${b64('t')}\t${b64('')}`, 'Z', ''].join(
      '\n'
    )
    const dir = mkdtempSync(join(tmpdir(), 'bm-agentfan-bare-'))
    dirs.push(dir)
    const scriptPath = join(dir, 'agentfan.sh')
    writeFileSync(scriptPath, AGENTFAN_SCRIPT, 'utf8')
    // env -i: no HOME, no XDG_RUNTIME_DIR. PATH has to stay or nothing runs.
    const stdout = execFileSync('env', ['-i', `PATH=${bin}:/usr/bin:/bin`, 'sh', scriptPath], {
      input: stdin,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    expect(stdout).toContain('10.0.0.5')
  })
})

describe('reading an agent answer', () => {
  const base: AgentResponse = { ip: '10.0.0.1', status: 200, curlCode: 0, body: '' }

  it('separates a refused connection from a timeout', () => {
    // The difference matters: refused means a machine is there with no agent,
    // which the user can fix in one click; a timeout means nothing answered.
    expect(classifyAgent({ ...base, curlCode: 7, status: 0 })).toBe('refused')
    expect(classifyAgent({ ...base, curlCode: 28, status: 0 })).toBe('timeout')
    expect(agentReachMessage({ ...base, curlCode: 7, status: 0 })).toContain('not installed')
  })

  it('treats a rejected token as its own state, not as an error', () => {
    expect(classifyAgent({ ...base, status: 401 })).toBe('unauthorized')
    expect(classifyAgent({ ...base, status: 403 })).toBe('unauthorized')
    expect(agentReachMessage({ ...base, status: 401 })).toContain('token')
  })

  it('counts a 404 as a reachable agent that said no', () => {
    // The agent answered; it simply does not have what was asked for. Reading
    // that as unreachable would take a machine off the wall for a bad request.
    expect(classifyAgent({ ...base, status: 404 })).toBe('ok')
  })

  it('treats a server error as an error rather than as an answer', () => {
    expect(classifyAgent({ ...base, status: 502 })).toBe('error')
  })
})
