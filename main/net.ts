/**
 * IPv4 arithmetic for the target rules, plus the glob a rule matches machines
 * with. It lives in this module rather than in `shared/` because a module may
 * only import its own files and `@shared/*`, and the app has no address
 * helpers of its own to reach for.
 *
 * Nothing here touches the network - it decides which addresses a rule is
 * about, and `fanout.ts` is what actually goes and looks.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export interface Cidr {
  /** Network address, already masked. */
  base: number
  prefix: number
}

/**
 * Addresses are held as unsigned 32-bit numbers. Arithmetic, not bit shifting,
 * because `<<` in JavaScript works on signed int32 and anything above
 * 127.255.255.255 comes back negative.
 */
export function ipToInt(ip: string): number | null {
  const match = IPV4_RE.exec(ip.trim())
  if (!match) return null
  let out = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i])
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    out = out * 256 + octet
  }
  return out
}

export function intToIp(value: number): string {
  let rest = Math.trunc(value)
  const parts: number[] = []
  for (let i = 0; i < 4; i++) {
    parts.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  }
  return parts.join('.')
}

export function parseCidr(text: string): Cidr | null {
  const parts = text.trim().split('/')
  if (parts.length !== 2) return null
  const base = ipToInt(parts[0])
  const prefix = Number(parts[1])
  if (base == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const size = 2 ** (32 - prefix)
  return { base: base - (base % size), prefix }
}

export function cidrContains(cidr: Cidr, value: number): boolean {
  const size = 2 ** (32 - cidr.prefix)
  return value >= cidr.base && value < cidr.base + size
}

/** `10.0.0.10-10.0.0.40` and the short `10.0.0.10-40` both work. */
export function parseRange(text: string): { from: number; to: number } | null {
  const trimmed = text.trim()
  const dash = trimmed.indexOf('-')
  if (dash <= 0) return null
  const from = ipToInt(trimmed.slice(0, dash))
  if (from == null) return null
  const tail = trimmed.slice(dash + 1).trim()
  let to: number | null
  if (tail.includes('.')) {
    to = ipToInt(tail)
  } else {
    const last = Number(tail)
    to = Number.isInteger(last) && last >= 0 && last <= 255 ? Math.floor(from / 256) * 256 + last : null
  }
  if (to == null || to < from) return null
  return { from, to }
}

export type TargetKind = 'host' | 'cidr' | 'range'

export interface Enumerated {
  ips: string[]
  /** How many the rule covers, before `cap` was applied. */
  total: number
  truncated: boolean
  problem: string | null
}

/**
 * Every address a rule names, capped. A /24 is 254 usable addresses, not 256:
 * the network and broadcast addresses are not machines. /31 and /32 are the
 * exception, where every address in the block is one.
 */
export function enumerateRule(kind: TargetKind, value: string, cap: number): Enumerated {
  const empty = (problem: string): Enumerated => ({ ips: [], total: 0, truncated: false, problem })
  let from: number
  let to: number
  if (kind === 'host') {
    const one = ipToInt(value)
    if (one == null) return empty(`"${value}" is not an IPv4 address`)
    from = one
    to = one
  } else if (kind === 'cidr') {
    const cidr = parseCidr(value)
    if (cidr == null) return empty(`"${value}" is not a CIDR block like 10.0.0.0/24`)
    const size = 2 ** (32 - cidr.prefix)
    from = size > 2 ? cidr.base + 1 : cidr.base
    to = size > 2 ? cidr.base + size - 2 : cidr.base + size - 1
  } else {
    const range = parseRange(value)
    if (range == null) return empty(`"${value}" is not a range like 10.0.0.10-10.0.0.40`)
    from = range.from
    to = range.to
  }
  const total = to - from + 1
  const take = Math.min(total, Math.max(1, cap))
  const ips: string[] = []
  for (let i = 0; i < take; i++) ips.push(intToIp(from + i))
  return { ips, total, truncated: total > take, problem: null }
}

export function compareIp(a: string, b: string): number {
  const left = ipToInt(a)
  const right = ipToInt(b)
  if (left == null || right == null) return a.localeCompare(b)
  return left - right
}

/**
 * The two wildcards are marked before escaping and put back after, so that
 * escaping cannot turn a `?` into the literal dot it was standing in for.
 */
function globToRegExp(pattern: string): RegExp {
  const STAR = '\u0000'
  const ANY = '\u0001'
  const marked = pattern.split('*').join(STAR).split('?').join(ANY)
  const escaped = marked.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`)
  const body = escaped.split(STAR).join('.*').split(ANY).join('.')
  return new RegExp(`^${body}$`, 'i')
}

/**
 * A comma-separated list of globs, matched against any of the values a machine
 * is known by (its address, its label). An empty pattern means "every machine"
 * - a rule with no filter applies everywhere, which is what the settings page
 * says it does.
 */
export function matchesGlob(pattern: string | undefined, values: Array<string | undefined>): boolean {
  const trimmed = (pattern ?? '').trim()
  if (!trimmed) return true
  const present = values.filter((v): v is string => typeof v === 'string' && v !== '')
  return trimmed
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .some((p) => {
      const re = globToRegExp(p)
      return present.some((value) => re.test(value))
    })
}
