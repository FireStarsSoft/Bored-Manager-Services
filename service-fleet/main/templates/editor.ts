/**
 * Importing, editing and removing the user's own templates.
 *
 * A template is a JSON document, so the form is a textarea and a file picker
 * rather than a field per property - and the check step is what makes that
 * usable: it parses, validates against the same rules the agent enforces, and
 * says everything that is wrong at once rather than one thing per attempt.
 *
 * Editing a shipped template is importing one with the same id. That is not a
 * special case in the code and it should not be one in the user's head either:
 * export it, change it, import it, and the library shows it as yours.
 */
import { createCheckSession, type ModuleCheckFinding, type ModuleCheckReport } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import type { ConfigStore, FleetConfig, StoredTemplate } from '../config'
import type { JumpCapabilities } from '../probe'
import type { FleetRules } from '../rules'
import { parseDocument, reportFor, type Library } from './library'
import { validateTemplate } from './validate'

interface Deps {
  config: () => FleetConfig
  rules: () => FleetRules
  capabilities: () => JumpCapabilities
}

interface ImportPlan {
  id: string
  document: unknown
}

function text(values: Record<string, unknown>, key: string): string {
  const raw = values[key]
  return typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
}

export class TemplateEditor {
  private session = createCheckSession<ImportPlan>()

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore,
    private deps: Deps
  ) {}

  clear(): void {
    this.session.clear()
  }

  /** One row per template, shipped and user-written together. */
  rows(library: Library): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = library.entries.map((entry) => ({
      id: entry.id,
      name: entry.template.displayName,
      kind: entry.template.kind,
      version: entry.template.version,
      origin: entry.origin,
      // A shipped template the user has overridden is worth distinguishing from
      // one they wrote: the id is familiar but the contents are not ours.
      originLabel: entry.origin === 'seed' ? 'ships with the module' : 'yours',
      units: entry.template.units.join(', '),
      fields: entry.template.fields.length,
      privileged: entry.template.privileged,
      description: entry.template.description,
      editable: entry.origin === 'user',
      warnings: entry.findings.filter((finding) => finding.level === 'warning').length,
      updatedAt: entry.updatedAt ?? null
    }))
    for (const problem of library.problems) {
      rows.push({
        id: problem.id,
        name: problem.id,
        kind: '',
        version: '',
        origin: problem.origin,
        originLabel: problem.origin === 'seed' ? 'ships with the module' : 'yours',
        units: '',
        fields: 0,
        privileged: false,
        description: problem.findings.map((finding) => `${finding.where}: ${finding.message}`).join(' · '),
        editable: problem.origin === 'user',
        warnings: problem.findings.length,
        broken: true,
        updatedAt: null
      })
    }
    return rows
  }

  /**
   * The fields one template asks for, so the deploy form can draw them.
   *
   * Returned as rows rather than as a form spec: a spec is static JSON, and
   * which inputs a deploy needs is not known until a template is chosen.
   */
  fields(library: Library, id: string): Array<Record<string, unknown>> {
    const entry = library.entries.find((candidate) => candidate.id === id)
    if (!entry) return []
    return entry.template.fields.map((field) => ({
      id: field.id,
      key: `field_${field.id}`,
      label: field.label,
      input: field.input,
      required: field.required,
      secret: field.secret,
      default: field.default ?? '',
      help: field.help ?? ''
    }))
  }

  check(raw: unknown): ModuleCheckReport {
    const values = (raw ?? {}) as Record<string, unknown>
    const pasted = text(values, 'document')
    const uploaded = text(values, 'file')
    const source = uploaded.trim() || pasted.trim()
    if (!source) {
      return {
        ok: false,
        findings: [{ level: 'error', label: 'paste a template, or choose a .json file' }]
      }
    }

    const parsed = parseDocument(source)
    if (parsed.error) {
      return {
        ok: false,
        findings: [{ level: 'error', label: 'that is not valid JSON', detail: parsed.error }]
      }
    }

    const validated = validateTemplate(parsed.document)
    if (!validated.ok || !validated.template) {
      return reportFor(parsed.document, null)
    }

    const config = this.deps.config()
    const rules = this.deps.rules()
    const existing = config.templates.find((entry) => entry.id === validated.template!.id)
    const report = reportFor(parsed.document, validated.template.id)
    const findings: ModuleCheckFinding[] = [...report.findings]

    if (!existing && config.templates.length >= rules.maxTemplates) {
      findings.push({
        level: 'error',
        label: `You already have ${config.templates.length} templates, which is the limit`,
        detail:
          'They live in this module\'s settings document, which the app caps. Remove one, or raise "User templates kept" in Rules.'
      })
      return { ok: false, findings }
    }
    if (existing) {
      findings.push({
        level: 'warning',
        label: `This replaces your existing "${validated.template.id}"`,
        detail: 'Machines already running it keep running it until you deploy again.'
      })
    }

    const token = this.session.issue(values, { id: validated.template.id, document: parsed.document })
    return { ok: true, token, findings }
  }

  apply(raw: unknown): OkResult {
    const payload = (raw ?? {}) as { token?: unknown; values?: unknown }
    const taken = this.session.take(typeof payload.token === 'string' ? payload.token : '', payload.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const { id, document } = taken.payload
    const now = Date.now()

    try {
      this.store.update((config) => {
        const at = config.templates.findIndex((entry) => entry.id === id)
        const record: StoredTemplate = {
          id,
          document,
          addedAt: at === -1 ? now : config.templates[at].addedAt,
          updatedAt: now
        }
        if (at === -1) config.templates.push(record)
        else config.templates[at] = record
      })
    } catch (err) {
      // Over the storage grant. The message names the way out rather than the
      // exception, because "payload is larger than 512 KB" is not actionable.
      return {
        ok: false,
        error: `that template does not fit in this module's settings document (${
          err instanceof Error ? err.message : String(err)
        }). Remove a template you no longer use.`
      }
    }

    this.ctx.log(`service-fleet: template ${id} imported`)
    return { ok: true, data: `${id} saved.` }
  }

  delete(idRaw: unknown): OkResult {
    const id = String(idRaw ?? '')
    const config = this.deps.config()
    if (!config.templates.some((entry) => entry.id === id)) {
      return {
        ok: false,
        error: `"${id}" is not one of your templates - the ones that ship with the module cannot be removed`
      }
    }
    this.store.update((document) => {
      document.templates = document.templates.filter((entry) => entry.id !== id)
    })
    this.ctx.log(`service-fleet: template ${id} removed`)
    // Deliberately says what it did *not* do: removing a description is not
    // removing what it installed, and a user who expected otherwise should
    // find out here rather than from a container that is still running.
    return { ok: true, data: `${id} removed from the library. Anything already deployed keeps running.` }
  }
}
