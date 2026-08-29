/**
 * The same rules the agent enforces, checked here first.
 *
 * This is a second implementation of `agent/boredagent/templates/validate.py`,
 * and that duplication is deliberate rather than accidental. The agent's copy is
 * the one that matters - it is what stands between a JSON document and root on
 * somebody's machine, and it runs whether the template arrived from this module
 * or from `curl`. This copy exists so a user editing a template in the app is
 * told what is wrong **before** it is pushed to fifty machines, one of which
 * would otherwise be the first thing to tell them.
 *
 * The two are kept in step by `tests/unit/template-schema.test.ts`, which reads
 * the seed templates through this validator and asserts the same verdicts the
 * agent's tests assert. If they ever disagree, the agent wins: it is the one
 * with something to lose.
 */

/** Every opcode the agent will execute. Anything else is refused here too. */
export const OPCODES = [
  'dockerRun',
  'dockerRm',
  'dockerStop',
  'dockerPull',
  'dockerRmi',
  'download',
  'writeFile',
  'mkdir',
  'chmod',
  'systemctl',
  'apt',
  'run',
  'script'
] as const

/** The one opcode that reaches a shell. */
const PRIVILEGED_OPCODES = new Set(['script'])

/** Directories a template may write into. */
export const WRITABLE_PREFIXES = [
  '/etc/systemd/system/',
  '/opt/',
  '/etc/boredagent-services/',
  '/var/lib/boredagent-services/',
  '/usr/local/bin/'
] as const

export const SCHEMA_VERSION = 1

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/
const FIELD_ID_RE = /^[a-z][a-z0-9_]{0,31}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const UNIT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
const SYSTEMD_UNIT_RE = /^[a-zA-Z0-9@_.-]{1,96}\.(service|timer|socket)$/
const SHA256_RE = /^[0-9a-f]{64}$/
const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g
const WHOLE_PLACEHOLDER_RE = /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/

export type FindingLevel = 'error' | 'warning' | 'info'

export interface TemplateFinding {
  level: FindingLevel
  where: string
  message: string
}

export interface TemplateField {
  id: string
  label: string
  input: 'text' | 'password' | 'number' | 'checkbox' | 'select'
  required: boolean
  secret: boolean
  default?: string
  options: string[]
  help?: string
}

export interface ParsedTemplate {
  id: string
  displayName: string
  kind: 'container' | 'service'
  version: string
  description: string
  privileged: boolean
  fields: TemplateField[]
  units: string[]
  requiredUnits: string[]
  primaryUnit: string | null
}

export interface TemplateValidation {
  ok: boolean
  findings: TemplateFinding[]
  template: ParsedTemplate | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function placeholders(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(PLACEHOLDER_RE)) out.push(match[1])
  return out
}

class Findings {
  readonly list: TemplateFinding[] = []

  error(where: string, message: string): void {
    this.list.push({ level: 'error', where, message })
  }

  warn(where: string, message: string): void {
    this.list.push({ level: 'warning', where, message })
  }

  get failed(): boolean {
    return this.list.some((finding) => finding.level === 'error')
  }
}

function checkPlaceholders(f: Findings, where: string, text: string, known: Set<string>): void {
  for (const name of placeholders(text)) {
    if (!known.has(name)) {
      f.error(where, `refers to {{${name}}}, which is not one of this template's fields`)
    }
  }
}

function checkPath(f: Findings, where: string, path: string): void {
  if (!path.startsWith('/')) {
    f.error(where, `"${path}" is not an absolute path`)
    return
  }
  if (path.split('/').includes('..')) {
    f.error(where, `"${path}" contains "..", which could leave the allowed directories`)
    return
  }
  if (placeholders(path).length) {
    f.error(where, `"${path}" interpolates a field into a path; paths have to be literal`)
    return
  }
  if (!WRITABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    f.error(where, `"${path}" is outside the directories a template may write to (${WRITABLE_PREFIXES.join(', ')})`)
  }
}

/** Accept a literal, or one whole field standing in for the value. */
function literalOrField(
  f: Findings,
  where: string,
  value: string,
  known: Set<string>,
  what: string
): string | null {
  const whole = WHOLE_PLACEHOLDER_RE.exec(value)
  if (whole) {
    if (!known.has(whole[1])) {
      f.error(where, `refers to {{${whole[1]}}}, which is not one of this template's fields`)
    }
    return null
  }
  if (placeholders(value).length) {
    f.error(where, `builds its ${what} out of a field and other text; it has to be either a literal or one whole field`)
    return null
  }
  return value
}

function checkStep(f: Findings, where: string, raw: unknown, known: Set<string>, privileged: boolean): void {
  if (!isRecord(raw)) {
    f.error(where, 'is not an object')
    return
  }
  const op = str(raw['op'])
  if (!op) {
    f.error(where, 'has no `op`')
    return
  }
  if (!(OPCODES as readonly string[]).includes(op)) {
    f.error(where, `"${op}" is not one of the opcodes a template may use (${OPCODES.join(', ')})`)
    return
  }
  if (PRIVILEGED_OPCODES.has(op) && !privileged) {
    f.error(where, `"${op}" runs a shell, so it is only allowed in a template that declares "privileged": true`)
    return
  }

  if (['dockerRm', 'dockerStop', 'dockerRmi', 'dockerPull'].includes(op)) {
    const target = str(raw['target'])
    if (!target) f.error(where, `\`${op}\` needs a \`target\``)
    else if (op !== 'dockerPull' && !UNIT_NAME_RE.test(target)) {
      f.error(where, `"${target}" is not a valid container name`)
    }
  } else if (op === 'download') {
    const url = str(raw['url'])
    const dest = str(raw['dest'])
    const digest = str(raw['sha256'])
    if (!url) f.error(where, '`download` needs a `url`')
    else {
      const literal = literalOrField(f, where, url, known, 'url')
      if (literal && !/^https?:\/\//.test(literal)) f.error(where, '`download` needs an http(s) `url`')
    }
    if (!dest) f.error(where, '`download` needs a `dest`')
    else checkPath(f, where, dest)
    if (!digest) {
      f.error(where, '`download` needs a `sha256`; a URL on its own is not reviewable')
    } else {
      const literal = literalOrField(f, where, digest, known, 'sha256')
      if (literal && !SHA256_RE.test(literal.toLowerCase())) {
        f.error(where, '`download` needs a 64-character hex `sha256`')
      }
    }
  } else if (op === 'writeFile') {
    const path = str(raw['path'])
    if (!path) f.error(where, '`writeFile` needs a `path`')
    else checkPath(f, where, path)
    if (typeof raw['content'] !== 'string') f.error(where, '`writeFile` needs string `content`')
    else checkPlaceholders(f, where, raw['content'], known)
  } else if (op === 'mkdir' || op === 'chmod') {
    const path = str(raw['path'])
    if (!path) f.error(where, `\`${op}\` needs a \`path\``)
    else checkPath(f, where, path)
    if (op === 'chmod' && !/^0?[0-7]{3}$/.test(String(raw['mode'] ?? ''))) {
      f.error(where, '`chmod` needs an octal `mode` like "0644"')
    }
  } else if (['systemctl', 'apt', 'run', 'dockerRun'].includes(op)) {
    const argv = raw['argv']
    if (!Array.isArray(argv) || !argv.length) f.error(where, `\`${op}\` needs a non-empty \`argv\` array`)
    else if (argv.length > 64) f.error(where, '`argv` has more than 64 entries')
    else if (!argv.every((entry) => typeof entry === 'string')) {
      f.error(where, 'every `argv` entry has to be a string')
    } else {
      for (const entry of argv) checkPlaceholders(f, where, entry as string, known)
    }
    if (op === 'run') {
      const program = str(raw['program'])
      if (!program) f.error(where, '`run` needs a `program`')
      else if (!program.startsWith('/') && program.includes('/')) {
        f.error(where, `"${program}" is neither an absolute path nor a bare command name`)
      }
    }
  } else if (op === 'script') {
    const body = raw['body']
    if (typeof body !== 'string' || !body.trim()) f.error(where, '`script` needs a non-empty `body`')
    else checkPlaceholders(f, where, body, known)
  }
}

function checkSteps(f: Findings, where: string, raw: unknown, known: Set<string>, privileged: boolean): void {
  if (raw == null) return
  if (!Array.isArray(raw)) {
    f.error(where, 'is not an array')
    return
  }
  if (raw.length > 64) {
    f.error(where, 'has more than 64 steps')
    return
  }
  raw.forEach((entry, index) => checkStep(f, `${where}[${index}]`, entry, known, privileged))
}

function readFields(f: Findings, raw: unknown): TemplateField[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) {
    f.error('fields', 'is not an array')
    return []
  }
  if (raw.length > 32) {
    f.error('fields', 'declares more than 32 fields')
    return []
  }
  const out: TemplateField[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const where = `fields[${index}]`
    if (!isRecord(entry)) {
      f.error(where, 'is not an object')
      return
    }
    const id = str(entry['id'])
    if (!id || !FIELD_ID_RE.test(id)) {
      f.error(where, 'needs an `id` of lowercase letters, digits and underscores')
      return
    }
    if (seen.has(id)) {
      f.error(where, `field "${id}" is declared twice`)
      return
    }
    seen.add(id)
    const label = str(entry['label'])
    if (!label) {
      f.error(where, `field "${id}" has no label`)
      return
    }
    const input = (str(entry['input']) ?? 'text') as TemplateField['input']
    if (!['text', 'password', 'number', 'checkbox', 'select'].includes(input)) {
      f.error(where, `"${input}" is not a known input kind`)
      return
    }
    const options = Array.isArray(entry['options'])
      ? (entry['options'] as unknown[]).filter((o): o is string => typeof o === 'string')
      : []
    if (input === 'select' && !options.length) {
      f.error(where, `field "${id}" is a select with no options`)
      return
    }
    out.push({
      id,
      label,
      input,
      required: entry['required'] === true,
      secret: entry['secret'] === true || input === 'password',
      default: str(entry['default']) ?? undefined,
      options,
      help: str(entry['help']) ?? undefined
    })
  })
  return out
}

/** Read one template document. Never throws; never half-builds. */
export function validateTemplate(raw: unknown): TemplateValidation {
  const f = new Findings()
  if (!isRecord(raw)) {
    f.error('template', 'is not a JSON object')
    return { ok: false, findings: f.list, template: null }
  }

  const schemaVersion = raw['schemaVersion'] ?? SCHEMA_VERSION
  if (typeof schemaVersion !== 'number' || schemaVersion > SCHEMA_VERSION) {
    f.error('schemaVersion', `is ${String(schemaVersion)}; this module understands up to ${SCHEMA_VERSION}`)
    return { ok: false, findings: f.list, template: null }
  }

  const id = str(raw['id'])
  if (!id || !ID_RE.test(id)) {
    f.error('id', 'needs to be 2-32 lowercase letters, digits and dashes, starting with a letter')
  }
  const displayName = str(raw['displayName']) ?? id ?? ''
  if (!displayName) f.error('displayName', 'is missing')
  const kind = str(raw['kind'])
  if (kind !== 'container' && kind !== 'service') f.error('kind', 'has to be "container" or "service"')
  const version = str(raw['version']) ?? '1.0.0'
  if (!VERSION_RE.test(version)) f.error('version', 'is not in x.y.z form')

  const privileged = raw['privileged'] === true
  const fields = readFields(f, raw['fields'])
  const known = new Set(fields.map((field) => field.id))

  const units: string[] = []
  const requiredUnits: string[] = []
  let primaryUnit: string | null = null
  let primaryCount = 0

  if (kind === 'container') {
    const block = raw['container']
    const list = isRecord(block) ? block['units'] : null
    if (!Array.isArray(list) || !list.length) {
      f.error('container.units', 'needs at least one unit')
    } else {
      const seen = new Set<string>()
      list.forEach((entry, index) => {
        const where = `container.units[${index}]`
        if (!isRecord(entry)) {
          f.error(where, 'is not an object')
          return
        }
        const name = str(entry['name'])
        const image = str(entry['image'])
        if (!name || !UNIT_NAME_RE.test(name)) {
          f.error(where, 'needs a valid container `name`')
          return
        }
        if (seen.has(name)) {
          f.error(where, `container "${name}" is declared twice`)
          return
        }
        seen.add(name)
        if (!image) {
          f.error(where, `container "${name}" has no \`image\``)
          return
        }
        if (placeholders(image).length || placeholders(name).length) {
          f.error(where, 'a container name or image may not interpolate a field')
          return
        }
        for (const arg of Array.isArray(entry['args']) ? (entry['args'] as unknown[]) : []) {
          if (typeof arg === 'string') checkPlaceholders(f, where, arg, known)
        }
        const env = isRecord(entry['env']) ? entry['env'] : {}
        for (const [key, value] of Object.entries(env)) {
          if (typeof value !== 'string') {
            f.error(where, 'every `env` key and value has to be a string')
            continue
          }
          checkPlaceholders(f, `${where}.env.${key}`, value, known)
        }
        checkSteps(f, `${where}.preInstall`, entry['preInstall'], known, privileged)
        units.push(name)
        if (entry['optional'] !== true) requiredUnits.push(name)
        if (entry['primary'] === true) {
          primaryCount++
          primaryUnit = name
        }
      })
    }
  } else if (kind === 'service') {
    const block = raw['service']
    const list = isRecord(block) ? block['units'] : null
    if (!Array.isArray(list) || !list.length) {
      f.error('service.units', 'needs at least one unit')
    } else {
      const seen = new Set<string>()
      list.forEach((entry, index) => {
        const where = `service.units[${index}]`
        if (!isRecord(entry)) {
          f.error(where, 'is not an object')
          return
        }
        const unit = str(entry['unit'])
        if (!unit || !SYSTEMD_UNIT_RE.test(unit)) {
          f.error(where, 'needs a `unit` like "something.service"')
          return
        }
        if (seen.has(unit)) {
          f.error(where, `unit "${unit}" is declared twice`)
          return
        }
        seen.add(unit)
        checkSteps(f, `${where}.install`, entry['install'], known, privileged)
        checkSteps(f, `${where}.uninstall`, entry['uninstall'], known, privileged)
        units.push(unit)
        if (entry['optional'] !== true) requiredUnits.push(unit)
        if (entry['primary'] === true) {
          primaryCount++
          primaryUnit = unit
        }
      })
    }
  }

  if (units.length && primaryCount !== 1) {
    f.error('units', `exactly one unit has to be \`primary\` (found ${primaryCount})`)
  }

  if (privileged) {
    f.warn(
      'privileged',
      'runs a shell as root on every machine it is deployed to. Only import this from a source you trust.'
    )
  }

  if (f.failed) return { ok: false, findings: f.list, template: null }

  // Primary first, so the list doubles as "which unit's log is the default".
  const ordered = primaryUnit ? [primaryUnit, ...units.filter((u) => u !== primaryUnit)] : units
  return {
    ok: true,
    findings: f.list,
    template: {
      id: id ?? '',
      displayName,
      kind: kind as 'container' | 'service',
      version,
      description: str(raw['description']) ?? '',
      privileged,
      fields,
      units: ordered,
      requiredUnits,
      primaryUnit
    }
  }
}
