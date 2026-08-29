/**
 * The template library: what ships with the module, plus what the user added.
 *
 * The six seeds are imported from `service-fleet/templates/*.json` rather than
 * written as TypeScript, so the file a user exports and the file the module
 * ships are the same kind of thing - and so `npm run pack` hashes them along
 * with everything else. They are read-only at runtime: the module folder is
 * verified byte for byte after install, so writing into it would make the app
 * report the module as modified.
 *
 * Anything the user writes goes into module config instead, which is what
 * `ctx.configSet` is for and what the storage grant sizes.
 */
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import type { StoredTemplate } from '../config'
import { validateTemplate, type ParsedTemplate, type TemplateFinding } from './validate'

import honeygain from '../../templates/honeygain.container.json'
import pawns from '../../templates/pawns.container.json'
import packetstream from '../../templates/packetstream.container.json'
import pawnsNative from '../../templates/pawns-native.service.json'
import genericBinary from '../../templates/generic-binary.service.json'
import genericApt from '../../templates/generic-apt.service.json'

/** The documents that ship inside the module, in the order the library lists them. */
export const SEED_TEMPLATES: readonly unknown[] = [
  honeygain,
  pawns,
  packetstream,
  pawnsNative,
  genericBinary,
  genericApt
]

export interface LibraryEntry {
  id: string
  /** `seed` ships with the module and cannot be edited; `user` came from config. */
  origin: 'seed' | 'user'
  template: ParsedTemplate
  document: unknown
  findings: TemplateFinding[]
  addedAt?: number
  updatedAt?: number
}

export interface LibraryProblem {
  id: string
  origin: 'seed' | 'user'
  findings: TemplateFinding[]
}

export interface Library {
  entries: LibraryEntry[]
  /** Documents that will not load, and why. Surfaced rather than swallowed. */
  problems: LibraryProblem[]
}

/**
 * Build the library from the seeds and whatever the user stored.
 *
 * Everything is re-validated on every read rather than parsed once and cached.
 * A user template written against an older schema stops loading when the rules
 * tighten, which is the point: the alternative is trusting a document forever
 * because it was trusted once.
 *
 * A user template with a seed's id **wins**. That is deliberate - it is how a
 * user adapts a shipped template (export, edit, import under the same id)
 * without having to invent a new name for it - and the origin says `user`, so
 * the page can show that a shipped template has been overridden.
 */
export function buildLibrary(stored: readonly StoredTemplate[]): Library {
  const entries = new Map<string, LibraryEntry>()
  const problems: LibraryProblem[] = []

  for (const document of SEED_TEMPLATES) {
    const result = validateTemplate(document)
    if (!result.ok || !result.template) {
      // A shipped template that does not validate is a bug in this module, not
      // in anything the user did - but it still has to be visible rather than
      // silently missing from the list.
      const id = (document as { id?: string })?.id ?? 'unknown'
      problems.push({ id, origin: 'seed', findings: result.findings })
      continue
    }
    entries.set(result.template.id, {
      id: result.template.id,
      origin: 'seed',
      template: result.template,
      document,
      findings: result.findings
    })
  }

  for (const record of stored) {
    const result = validateTemplate(record.document)
    if (!result.ok || !result.template) {
      problems.push({ id: record.id, origin: 'user', findings: result.findings })
      continue
    }
    if (result.template.id !== record.id) {
      problems.push({
        id: record.id,
        origin: 'user',
        findings: [
          {
            level: 'error',
            where: 'id',
            message: `stored as "${record.id}" but the template calls itself "${result.template.id}"`
          }
        ]
      })
      continue
    }
    entries.set(record.id, {
      id: record.id,
      origin: 'user',
      template: result.template,
      document: record.document,
      findings: result.findings,
      addedAt: record.addedAt,
      updatedAt: record.updatedAt
    })
  }

  return {
    entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    problems
  }
}

export function findTemplate(library: Library, id: string): LibraryEntry | null {
  return library.entries.find((entry) => entry.id === id) ?? null
}

/** Findings in the app's own check vocabulary, for a `checkForm`. */
export function toCheckFindings(findings: readonly TemplateFinding[]): ModuleCheckFinding[] {
  return findings.map((finding) => ({
    level: finding.level === 'error' ? 'error' : finding.level === 'warning' ? 'warning' : 'info',
    label: `${finding.where}: ${finding.message}`
  }))
}

/**
 * Parse a document a user pasted or uploaded, and say what is wrong with it.
 *
 * JSON parse failures are reported with the position, because a template is
 * usually a few hundred lines and "unexpected token" alone is not enough to
 * find the comma.
 */
export function parseDocument(text: string): { document: unknown; error: string | null } {
  const trimmed = text.trim()
  if (!trimmed) return { document: null, error: 'nothing was pasted or uploaded' }
  try {
    return { document: JSON.parse(trimmed) as unknown, error: null }
  } catch (err) {
    return { document: null, error: err instanceof Error ? err.message : 'not valid JSON' }
  }
}

/** A report for a `checkForm`, from a document that has not been stored yet. */
export function reportFor(document: unknown, expectedId: string | null): ModuleCheckReport {
  const result = validateTemplate(document)
  const findings = toCheckFindings(result.findings)
  if (!result.ok || !result.template) {
    return { ok: false, findings: findings.length ? findings : [{ level: 'error', label: 'this is not a usable template' }] }
  }
  if (expectedId && result.template.id !== expectedId) {
    findings.push({
      level: 'error',
      label: `this template calls itself "${result.template.id}", but it is being saved as "${expectedId}"`
    })
    return { ok: false, findings }
  }
  findings.push({
    level: 'pass',
    label: `${result.template.displayName} (${result.template.kind})`,
    detail: `${result.template.units.length} unit(s): ${result.template.units.join(', ')}. ${
      result.template.fields.length
    } field(s) to fill in.`
  })
  return { ok: true, findings }
}

/** The JSON a user copies out of the export box. */
export function exportDocument(entry: LibraryEntry): string {
  return `${JSON.stringify(entry.document, null, 2)}\n`
}
